/* Copyright 2012 Mozilla Foundation and Mozilla contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* Copyright © 2014, Deutsche Telekom, Inc. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "SE", function() {
  let obj = {};
  Cu.import("resource://gre/modules/se_consts.js", obj);
  return obj;
});

// TBD: In the Multi-sim, there is more than one client.
// For now, use default clientID as 0. Ideally, we would like to
// know which clients (uicc slot) are connected to CLF over SWP interface.
const PREFERRED_UICC_CLIENTID = libcutils.property_get(
                                  "ro.moz.se.def_client_id", "0");

const SE_IPC_SECUREELEMENT_MSG_NAMES = [
  "SE:GetSEReaders",
  "SE:OpenSession",
  "SE:OpenChannel",
  "SE:CloseChannel",
  "SE:TransmitAPDU",
  "SE:CloseAllByReader",
  "SE:CloseAllBySession"
];

// set to true in se_consts.js to see debug messages
let DEBUG = SE.DEBUG_SE;

function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement: " + s + "\n");
  }
}

const SE_CONTRACTID = "@mozilla.org/se;1";
const SE_CID =
  Components.ID("{48f4e650-28d2-11e4-8c21-0800200c9a66}");
const NS_XPCOM_SHUTDOWN_OBSERVER_ID = "xpcom-shutdown";

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                   "@mozilla.org/parentprocessmessagemanager;1",
                   "nsIMessageBroadcaster");

XPCOMUtils.defineLazyServiceGetter(this, "UUIDGenerator",
                  "@mozilla.org/uuid-generator;1",
                  "nsIUUIDGenerator");

XPCOMUtils.defineLazyServiceGetter(this, "iccProvider",
                   "@mozilla.org/ril/content-helper;1",
                   "nsIIccProvider");

function SecureElement() {
  Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
  gSEMessageManager.init(this);
}

SecureElement.prototype = {

  classID: SE_CID,
  classInfo: XPCOMUtils.generateCI({classID: SE_CID,
                  contractID: SE_CONTRACTID,
                  classDescription: "SecureElement",
                  interfaces: [Ci.nsIObserver]}),

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),

  /**
   * nsIObserver interface methods.
   */

  observe: function(subject, topic, data) {
    switch (topic) {
      case NS_XPCOM_SHUTDOWN_OBSERVER_ID:
      Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
      break;
    }
  }
};

XPCOMUtils.defineLazyGetter(this, "gSEMessageManager", function() {
  return {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMessageListener,
                       Ci.nsIObserver,
                       Ci.nsIIccListener]),

  secureelement: null,

  // Map that book-keeps all the necessary and vital info pertainining to
  // multiple sessions and channels for a given application (appId).
  // An application (appId) can open multiple sessions. In turn each session
  // can open multiple channels with the secure element.

  /*
     ------------------------------
       Structure of 'appInfoMap':
     ------------------------------
     { [ appId :// appId 1 (key)
               target   : msg.target
               sessions : { [11111 : // sessionId 1 (key)
                                    type :
                                    channels : { [aaaaa: // 'token' 1 (key)
                                                         type:
                                                         aid :
                                                         channelNumber :
                                                         openResponse : ]
                                                 [bbbbb: // 'token' 2 (key)
                                                         type:
                                                         aid :
                                                         channelNumber : ]
                                                 [ccccc: // 'token' 3 (key)
                                                         type:
                                                         aid :
                                                         channelNumber :
                                                         openResponse : ]
                                               }
                            ]
                            [22222 : // sessionId 2 (key)
                                    type :
                                    channels : { [ddddd: // 'token' 1 (key)
                                                         type:
                                                         aid :
                                                         channelNumber :
                                                         openResponse : ]
                                                 [eeeee: // 'token' 2 (key)
                                                         type:
                                                         aid :
                                                         channelNumber :
                                                         openResponse : ]
                                                 [fffff: // 'token' 3 (key)
                                                         type:
                                                         aid :
                                                         channelNumber :
                                                         openResponse : ]
                                               }
                            ]
                          } // End of 'sessions'
       ]
       [ appId : // appId 2 (key)
                 ...
                 ... : { [..... :
                                 ..
                                 .. : { .... :
                                              ..
                                              ..
                                              ..
                                              ..
                                      }
                        } ]
       ]
     }
  */
  appInfoMap: {},

  cardReady: null,

  init: function(secureelement) {
    this.secureelement = secureelement;

    Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);

    this._registerMessageListeners();
    this._initializeSEListeners();
  },

  _shutdown: function() {
    this.secureelement = null;

    Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
    this._unregisterMessageListeners();
    this._uninitializeSEListeners();
  },

  _registerMessageListeners: function() {
    ppmm.addMessageListener("child-process-shutdown", this);
    for (let msgname of SE_IPC_SECUREELEMENT_MSG_NAMES) {
      ppmm.addMessageListener(msgname, this);
    }
  },

  _unregisterMessageListeners: function() {
    ppmm.removeMessageListener("child-process-shutdown", this);
    for (let msgname of SE_IPC_SECUREELEMENT_MSG_NAMES) {
      ppmm.removeMessageListener(msgname, this);
    }
    ppmm = null;
  },

  _initializeSEListeners: function() {
    // Attach a listener to UICC state changes
    if (DEBUG) debug("Default Client ID " + PREFERRED_UICC_CLIENTID);
    iccProvider.registerIccMsg(PREFERRED_UICC_CLIENTID, this);
  },

  _uninitializeSEListeners: function() {
    // Detach the listener to UICC state changes
    iccProvider.unregisterIccMsg(PREFERRED_UICC_CLIENTID, this);
  },

  _registerMessageTarget: function(message) {
    let appInfoMap = this.appInfoMap;
    let appId = message.json.appId;
    let targetInfo = appInfoMap[appId];

    // If the application Id is already registered
    if (targetInfo) {
      debug("Already registered target! " + appId);
      return;
    }
    let newAppInfo = { target: message.target,
                       sessions: {} };
    appInfoMap[appId] = newAppInfo;
    if (DEBUG) debug("Registering a new target " + appId);
  },

  _unregisterMessageTarget: function(message) {
    let targets = this.appInfoMap;
    Object.keys(targets).forEach((appId) => {
      let targetInfo = targets[appId];
      if (targetInfo && targetInfo.target === message.target) {
        // Remove the target from the list of registered targets
        debug("Unregisterd MessageTarget for AppId : " + appId);
        this._closeAllChannelsByAppId(targets[appId], function(status) {
          if (status === SE.ERROR_GENERIC_FAILURE)
            debug("Err: Memory Leak? - Unable to close the channel held by \
                   the AppId : " + appId);
          delete targets[appId];
        });
        return;
      }
    });
  },

   _removeAllSessions: function(msg) {
    let allSessions = this.appInfoMap[msg.appId].sessions;
    // reset all sessions
    if (!!allSessions)
      allSessions = {};
  },

   _addSession: function(sessionId, msg) {
    let appId = msg.appId;
    let type = msg.type;

    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      if (DEBUG) debug("Unable to add session to the target: " + appId);
      return;
    }
    appInfo.sessions[sessionId] = { type: type,
                                    channels: {} };
  },

  _removeSessionEntry: function(msg) {
    let sessions = this.appInfoMap[msg.appId].sessions;
    if (!!sessions && sessions[msg.sessionId].type === msg.type)
      delete sessions[msg.sessionId];
  },

  _addChannel: function(channelInfo, msg) {
    let appId = msg.appId;
    let token = channelInfo.token;
    let status = SE.ERROR_GENERIC_FAILURE;

    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      debug("Unable to add session to the target: " + appId);
      return status;
    }
    let session = appInfo.sessions[msg.sessionId];
    if (!session) {
      debug("Unable to add session " + msg.sessionId + "appId:" + appId);
      return status;
    }

    let channel = session.channels[token];
    // If channel with this 'token' is not yet added AND session type matches
    if (!channel && (session.type === msg.type)) {
      // Add the entry
      session.channels[token] = { type: channelInfo.type,
                                  channel: channelInfo.channel,
                                  aid: msg.aid,
                                  response: channelInfo.openResponse };
      return SE.ERROR_SUCCESS;
    }
    if (DEBUG) debug("Unable to add channel entry , Type Mismatch - " + session.type + " Vs " +
                     msg.type + " (or) Channel already added:" + channel + " " +
                     session.channels[token].channel);
    return status;
  },

   _removeChannel: function(channelNumber, type) {
    let targets = this.appInfoMap;
    Object.keys(targets).forEach((appId) => {
      let sessions = targets[appId].sessions;
      Object.keys(sessions).forEach((sessionId) => {
        if (sessions[sessionId].type === type) {
          let channels = sessions[sessionId].channels;
          Object.keys(channels).forEach((token) => {
            if (channels[token].channel === channelNumber) {
              // We have found the match
              if (DEBUG) debug("Deleting channel with token : " + token +
                               ", channelNumber : " + channelNumber);
              delete channels[token];
            }
          }); // End of Channels keys
        }
      }); // End of Sessions keys
    }); // End of AppId keys
  },

  /*
   // Uncomment this function in order to debug the appInfoMap, while performing modifications to it.
  _debugMap: function(evtStr) {
    debug("----------------------------------------------------------------------------------------");
    debug(evtStr);
    let targets = this.appInfoMap;
    Object.keys(targets).forEach((appId) => {
      debug("appId : " + appId);
      debug("       target : " + targets[appId].target);
      let sessions = targets[appId].sessions;
      Object.keys(sessions).forEach((sessionId) => {
        debug("               sessions : " + sessionId);
        debug("                         type : " + sessions[sessionId].type);
        let channels = sessions[sessionId].channels;
        Object.keys(channels).forEach((token) => {
          debug("                               channels : " + token);
          debug("                                         channelNumber : " + channels[token].channel);
          debug("                                         AID : " + this._byte2hexString(channels[token].aid));
        }); // End of Channels keys
      }); // End of Sessions keys
    }); // End of AppId keys
    debug("----------------------------------------------------------------------------------------");
  },*/

  _isChannelRegistered: function(channel, msg) {
    let appId = msg.json.appId;
    let sessionId = msg.json.sessionId;
    let channelToken = msg.json.channelToken;

    if (channel === SE.BASIC_CHANNEL) {
      // Is it basic channel ? If so, we are not supporting it
      return false;
    }

    if (this.appInfoMap[appId].sessions[sessionId].channels[channelToken].channel === channel) {
       return true;
    }
    debug("Not a valid Channel Token - " + channelToken);
    return true;
  },

  _getAllChannelsByAppId: function(appId) {
    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      debug("Unable to add session to the target: " + appId);
      return null;
    }
    let sessions = appInfo.sessions;
    let channelNumbers = new Array();
    Object.keys(sessions).forEach((aKey) => {
      let channels = sessions[aKey].channels;
      if (channels !== undefined) {
        channelNumbers = channelNumbers.concat(this._getChannels(channels));
      }
    });
    return (channelNumbers.length > 0) ? channelNumbers : null;
  },

  _getChannelCountBySessionId: function(sessionId, appId) {
    let session = this.appInfoMap[appId].sessions[sessionId];
    if (!session) {
      debug("Unable to get session for the target appId : " + appId + " sessionId: " + sessionId);
      return null;
    }
    return Object.keys(session.channels).length;
  },

  _getAllChannelsBySessionId: function(sessionId, appId) {
    let sessions = this.appInfoMap[appId].sessions[sessionId];
    if (!sessions) {
      debug("Unable to get session for the target appId : " + appId + " sessionId: " + sessionId);
      return null;
    }
    return this._getChannels(sessions.channels);
  },

  _getChannels: function(channels) {
    if (!channels)
      return null;

    let channelNumbers = new Array();
    Object.keys(channels).forEach((aKey) => {
      let channelNumber = channels[aKey].channelNumber;
      if (channelNumber !== undefined) {
        channelNumbers.push(channelNumber);
      }
    });
    return (channelNumbers.length > 0) ? channelNumbers : null;
  },

  _getChannel: function(data) {
    return this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].channel;
  },

  _getType: function(data) {
    return this.appInfoMap[data.appId].sessions[data.sessionId].type;
  },

  _isRegisteredForGivenType: function(type, data) {
    return (this._getType(data) === type);
  },

  _validateAID: function(aid, data) {
    let regAid = this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].aid;
    return this._compareAIDs(aid, regAid);
  },

  _compareAIDs: function(aid1, aid2) {
    return (this._byte2hexString(aid1) === this._byte2hexString(aid2));
  },

  _isValidSession: function(data) {
    return (!this.appInfoMap[data.appId].sessions[data.sessionId] ? false : true);
  },

  _getChannelNumber: function(cla) {
    // As per GlobalPlatform Card Specification v2.2, check the 7th bit
    let classByteCoding = (cla & 0x40);
    if (classByteCoding == 0x00) {
      // If 7 th bit is not set, then channel number is encoded in the 2 rightmost bits
      // Refer to section 11.1.4.1. Possible logical channel numbers are:-
      // (00: 0, 01 : 1, 10 : 2, 11 : 3)
      return cla & 0x03;
    } else {
      // If the 7th bit is set, channel number is encoded in the 4 rightmost bits
      // Refer to section  11.1.4.2. Note that Supplementary Logical Channels start from 4 to 19.
      // So add 4!
      return (cla & 0x0F) + 4;
    }
  },

  _setChannelToClassByte(cla, channelNumber) {
    if (channelNumber < 4) {
      // b7 = 0 indicates the first interindustry class byte coding
      cla = (((cla & 0x9C) & 0xFF) | channelNumber);
    } else if (channelNumber < 20) {
      // b7 = 1 indicates the further interindustry class byte coding
      cla = (((cla & 0xB0) & 0xFF) | 0x40 | (channelNumber - 4));
    } else {
      debug("Channel number must be within [0..19]");
      return SE.ERROR_GENERIC_FAILURE;
    }
    return cla;
  },

  _openChannel: function(data, callback) {
    let error = null;
    do {
      // Sanity Checks!
      if (!this._isValidSession(data)) {
        error = "Invalid Session " + data.sessionId + " for appId : " + data.appId;
        break;
      }

      if (!this._isRegisteredForGivenType(data.type,
                                          {appId: data.appId, sessionId: data.sessionId})) {
        error = "Invalid / Unregistered sessiond ID: " + data.sessionId +
                " AND / OR AppId : " + data.appId + " for the given type : " + data.type;
        break;
      }

      if (data.aid.length < SE.MIN_AID_LEN || data.aid.length > SE.MAX_AID_LEN) {
        error = "Invalid AID length";
        break;
      }

      if (this._getChannelCountBySessionId(data.sessionId, data.appId) >=
            SE.MAX_CHANNELS_ALLOWED_PER_SESSION) {
        error = "Max channels per session exceed !!!";
        break;
      }

      // TBD: Validate the AID "data.aid" with ACE
    } while (false);

    if (error !== null) {
      if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      debug("Sanity Check fails for transmit command, Reason :- " + error);
      return;
    }

    if (data.type === SE.TYPE_UICC)
      this._doUiccOpenChannel(data, callback);
  },

  _doUiccOpenChannel: function(msg, callback) {
    let aidStr = this._byte2hexString(msg.aid);
    if (aidStr === "")
      aidStr = null; // If Null, and indeed no AID was passed, select the default applet is exists

    iccProvider.iccOpenChannel(PREFERRED_UICC_CLIENTID, aidStr, {
      notifyOpenChannelSuccess: function(channel) {
        // Now that we have received a 'channel', try to get the 'openResponse'
        gSEMessageManager._getOpenResponse(channel, function(response) {
          let token = UUIDGenerator.generateUUID().toString();
          let channelData = {channel: channel,
                             token: token,
                             openResponse: response,
                             type: SE.CHANNEL_TYPE_LOGICAL};
          let status = gSEMessageManager._addChannel(channelData, msg);
          if (callback) {
            callback({ status: response.status, token: token });
          }
        });
      },

      notifyError: function(error) {
        callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      }
    });
  },

  _getOpenResponse: function(channel, callback) {
    // cla: channel, ins: 0xC0, p1: 0x00, p2: 0x00
    let apduOpenRespBytes = new Uint8Array([(channel & 0xFF), SE.GET_RESPONSE, 0x00, 0x00, 0x00]);
    // lc: 0x00, implies data is empty AND le:0x00, indicates the UICC card to get
    // all the available response bytes.
    this._doUiccTransmit(apduOpenRespBytes, function(result) {
      if (DEBUG) debug('Open Response : ' + result.simResponse);
      callback(result);
    });
  },

  _transmit: function(data, callback) {
    let command = data.apdu;
    let error = null;
    do {
      // Sanity Checks!
      if (!this._isValidSession(data)) {
        error = "Invalid Session " + data.sessionId + " for appId : " + data.appId;
        break;
      }

      if (!this._validateAID(data.aid, data)) {
        error = "Invalid AID - " + data.aid + ", [appId: " + data.appId + ", sessionId: " +
                 data.sessionId + ", token: " + data.channelToken + " ]";
        break;
      }

      if (command.length > SE.MAX_APDU_LEN) {
        error = "Data length exceeds max limit - " + SE.MAX_APDU_LEN +
                " Extended APDU is not supported! : " + command.length;
        break;
      }

      if (command.length < SE.APDU_HEADER_LEN) {
        error: "command cannot not be smaller than 4 bytes";
        break;
      }

      if (((command[0] & (0xFF & 0x80) === 0)) &&
          ((0xFF & (command[0] & (0xFF & 0x60))) !== (0xFF & 0x20))) {
        if (command[1] === (0xFF & SE.INS_MANAGE_CHANNEL)) {
          error = "MANAGE CHANNEL command not permitted";
          break;
        }
        if ((command[1] === (0xFF & SE.INS_SELECT)) && (command[2] == (0xFF & 0x04))) {
          // SELECT by DF Name (p1=04) is not allowed
          error = "SELECT command not permitted";
          break;
        }
        if (DEBUG) debug("Attempting to transmit an ISO command");
      } else {
        if (DEBUG) debug("Attempting to transmit GlobalPlatform command");
      }

      // TBD: Validate the AID "data.aid" with ACE
    } while (false);

    if (error !== null) {
      if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      debug("Sanity Check fails for transmit command, Reason :- " + error);
      return;
    }

    // See GP Spec, 11.1.4 Class Byte Coding
    command[0] = this._setChannelToClassByte(command[0], this._getChannel(data));

    let type = this._getType({appId: data.appId, sessionId: data.sessionId});
    if (type === SE.TYPE_UICC)
      this._doUiccTransmit(data.apdu, callback);
  },

  _doUiccTransmit: function(apduCmd, callback) {
    let cla = apduCmd[0] & 0xFF;
    let ins = apduCmd[1] & 0xFF;
    let p1 = apduCmd[2] & 0xFF;
    let p2 = apduCmd[3] & 0xFF;
    let p3 = ((apduCmd[4] === 0) || (apduCmd[4] === undefined)) ? 0 : (apduCmd[4] & 0xFF);
    // Check P3 > 0 AND the apdu length. The second condition is needed to explicitly
    // check if there are "data bytes' indeed. If there are no 'data bytes
    // (i;e; apduCmd.length is '5') and P3 is > 0, implies 'P3' shall be still interpreted as 'Le'.

    // TBD: This condition shall be revisited after adding 'Extended APDU support'
    let data = ((p3 > 0) && (apduCmd.length > 5)) ? this._byte2hexString(apduCmd.subarray(5)) : null;
    let channel = this._getChannelNumber(apduCmd[0] & 0xFF);

    if (DEBUG) debug("transmit on Channel # -!" + channel);
    iccProvider.iccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                                 (cla & 0xFC), ins, p1, p2, p3, data, {
      notifyExchangeAPDUResponse: function(sw1, sw2, length, simResponse) {
        callback({ status: SE.ERROR_SUCCESS, sw1: sw1, sw2: sw2, simResponse: simResponse });
      },

      notifyError: function(error) {
        callback({ status: SE.ERROR_GENERIC_FAILURE, error: error, simResponse: null });
      }
    });
  },

  _closeChannel: function(data, callback) {
    let error = null;
    do {
      // Sanity Checks!
      if (!this._isValidSession(data)) {
        error = "Invalid Session " + data.sessionId + " for appId : " + data.appId;
        break;
      }

      if (!this._validateAID(data.aid, data)) {
        error = "Invalid AID - " + data.aid + ", [appId: " + data.appId +
                ", sessionId: " + data.sessionId + ", token: " + data.channelToken + " ]";
      }

      // TBD: Validate the AID 'data.aid' with ACE
    } while (false);

    if (error !== null) {
      if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      return;
    }

    let type = this._getType({appId: data.appId, sessionId: data.sessionId});
    // TBD: Validate the AID 'data.aid' with ACE
    if (type === SE.TYPE_UICC)
      this._doUiccCloseChannel(this._getChannel(data), callback);
  },

  _doUiccCloseChannel: function(channelNumber, callback) {
    this._closeAll([channelNumber],
                   callback);
  },

  _closeAllChannelsByAppId: function(appId, callback) {
    this._closeAll(this._getAllChannelsByAppId(appId),
                   callback);
  },

  _closeAllChannelsBySessionId: function(sessionId, appId, callback) {
    this._closeAll(this._getAllChannelsBySessionId(sessionId, appId),
                   callback);
  },

  _closeAll: function(channels, callback) {
    if (channels === null) {
      if (callback)
        callback({ status: SE.ERROR_GENERIC_FAILURE, error: "No Active Channels to be closed!"});
      return;
    }

    let status = SE.ERROR_SUCCESS;
    let count = 0;

    for (let index = 0; index < channels.length; index++) {
      if (DEBUG) debug("Attempting to Close Channel # : " + channels[index]);
      let channelNumber = channels[index];

      if (channelNumber === SE.BASIC_CHANNEL) {
        debug("Basic Channel can never be closed!");
        status |= SE.ERROR_GENERIC_FAILURE;
        if (callback && (++count === channels.length))
          callback({ status: SE.ERROR_GENERIC_FAILURE, error: "Basic Channel can never be closed!"});
      }

      iccProvider.iccCloseChannel(PREFERRED_UICC_CLIENTID, channelNumber, {
        notifyCloseChannelSuccess: function() {
          if (DEBUG) debug("notifyCloseChannelSuccess # : " + channelNumber);
          gSEMessageManager._removeChannel(channelNumber, SE.TYPE_UICC);
          status |= SE.ERROR_SUCCESS;
          if (callback && (++count === channels.length))
            callback({ status: status });
        },

        notifyError: function(error) {
          status |= SE.ERROR_GENERIC_FAILURE;
          if (callback && (++count === channels.length))
            callback({ status: status, error: error });
        }
      });
    }
  },

  _notifyAllTargetsOnSEStateChange: function(type, isPresent) {
    let targets = this.appInfoMap;
    Object.keys(targets).forEach((aKey) => {
      let targetInfo = targets[aKey];
      if (targetInfo) {
        targetInfo.target.sendAsyncMessage("SE:NotifySEStateChange", {
                                            type: type,
                                            present: isPresent });
      }
    });
  },

  _isUiccInReadyState: function() {
    // Consider following Card states as not quite ready for issuing IccChannel* related commands
    let notReadyStates = [
      "unknown",
      "illegal",
      "personalizationInProgress",
      "permanentBlocked"
    ];
    let cardState = iccProvider.getCardState(PREFERRED_UICC_CLIENTID);
    return (((cardState !== null) && (notReadyStates.indexOf(cardState) == -1)) ? true : false);
  },

  _hexStringToBytes: function(hexString) {
    let bytes = [];
    let length = hexString.length;

    for (let i = 0; i < length; i += 2) {
      bytes.push(Number.parseInt(hexString.substr(i, 2), 16));
    }

    return bytes;
  },

  _byte2hexString: function(array) {
    let hexString = "";
    let hex;

    if (!array)
      return hexString;

    for (let i = 0; i < array.length; i++) {
      hex = array[i].toString(16).toUpperCase();
      if (hex.length === 1) {
        hexString += "0";
      }
      hexString += hex;
    }

    return hexString;
  },

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
    if (DEBUG) debug("Received '" + msg.name + "' message from content process" + ": " +
                     JSON.stringify(msg.json));
    let status = SE.ERROR_GENERIC_FAILURE;
    let message = msg;
    let promiseStatus = "Rejected";
    let options = { status: status,
                    resolverId: msg.json.resolverId };

    if (msg.name == "child-process-shutdown") {
      // By the time we receive child-process-shutdown, the child process has
      // already forgotten its permissions so we need to unregister the target
      // for every permission.
      this._unregisterMessageTarget(msg);
      return null;
    }

    if (SE_IPC_SECUREELEMENT_MSG_NAMES.indexOf(msg.name) != -1) {
      if (!msg.target.assertPermission("secureelement-manage")) {
        debug("SecureElement message " + msg.name +
              " from a content process with no 'secureelement-manage' privileges.");
        return null;
      }
    } else {
      debug("Ignoring unknown message type: " + msg.name);
      return null;
    }

    // This step is necessary as sometimes the card state change is not getting notified
    // during boot up sequence (Maybe due to a race condition ?)
    if (this.cardReady === null)
      this.cardReady = this._isUiccInReadyState();

    switch (msg.name) {
      case "SE:GetSEReaders":
        let secureelements = [];
        if (this.cardReady) {
          this._registerMessageTarget(msg);
          secureelements.push(SE.TYPE_UICC);
          options = { secureelements: secureelements,
                      resolverId: msg.json.resolverId };
          promiseStatus = "Resolved";
        }
        break;
      case "SE:OpenSession":
        if ((this.cardReady) && (msg.json.type === SE.TYPE_UICC)) {
          let sessionId = UUIDGenerator.generateUUID().toString();
          this._addSession(sessionId, msg.json);
          options = { sessionId: sessionId,
                      type: msg.json.type,
                      resolverId: msg.json.resolverId };
          promiseStatus = "Resolved";
        }
        break;
      case "SE:OpenChannel":
        this._openChannel(msg.json, function(result) {
          promiseStatus = (result.status === SE.ERROR_SUCCESS) ? "Resolved" : "Rejected";
          options = { aid: message.json.aid,
                      channelToken: result.token,
                      sessionId: message.json.sessionId,
                      resolverId: message.json.resolverId
                    };
          message.target.sendAsyncMessage(message.name + promiseStatus, options);
        });
        // Send the response from the callback, for now return!
        return;
      case "SE:TransmitAPDU":
        this._transmit(msg.json, function(result) {
          promiseStatus = (result.status === SE.ERROR_SUCCESS) ? "Resolved" : "Rejected";
          options = { channelToken: message.json.channelToken,
                      respApdu: result,
                      resolverId: message.json.resolverId
                    };
          message.target.sendAsyncMessage(message.name + promiseStatus, options);
        });
        // Send the response from the callback, for now return!
        return;
      case "SE:CloseChannel":
        this._closeChannel(msg.json, function(result) {
          promiseStatus = (result.status === SE.ERROR_SUCCESS) ? "Resolved" : "Rejected";
          message.target.sendAsyncMessage(message.name + promiseStatus, message.json);
        });
        // Send the response from the callback, for now return!
        return;
      case "SE:CloseAllBySession":
        this._closeAllChannelsBySessionId(msg.json.sessionId, msg.json.appId, function(status) {
          promiseStatus = (status === SE.ERROR_SUCCESS) ? "Resolved" : "Rejected";
          gSEMessageManager._removeSessionEntry(message.json);
          options = { sessionId: message.json.sessionId,
                      resolverId: message.json.resolverId };
          message.target.sendAsyncMessage(message.name + promiseStatus, options);
        });
        // Send the response from the callback, for now return!
        return;
      case "SE:CloseAllByReader":
        this._closeAllChannelsByAppId(msg.json.appId, function(status) {
          promiseStatus = (status === SE.ERROR_SUCCESS) ? "Resolved" : "Rejected";
          gSEMessageManager._removeAllSessions(message.json);
          options = { type: message.json.type,
                      resolverId: message.json.resolverId };
          message.target.sendAsyncMessage(message.name + promiseStatus, options);
        });
        // Send the response from the callback, for now return!
        return;
      default:
        throw new Error("Don't know about this message: " + msg.name);
        return;
    }
    msg.target.sendAsyncMessage(msg.name + promiseStatus, options);
  },

  /**
   * nsIObserver interface methods.
   */

  observe: function(subject, topic, data) {
    switch (topic) {
    case NS_XPCOM_SHUTDOWN_OBSERVER_ID:
      this._shutdown();
      break;
    }
  },

  /**
   * nsIIccListener interface methods.
   */
   notifyStkCommand: function() {},

   notifyStkSessionEnd: function() {},

   notifyCardStateChanged: function() {
     this.cardReady = this._isUiccInReadyState();
     this._notifyAllTargetsOnSEStateChange("uicc", this.cardReady);
     if (DEBUG) debug("CardStateChanged, " + "CardReady : " + this.cardReady);
   },

   notifyIccInfoChanged: function() {}
  };
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElement]);

