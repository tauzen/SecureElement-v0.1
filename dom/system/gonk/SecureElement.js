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
// For now, use default clientID as 0. Ideally, SE parent process would like to
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
  "SE:CloseAllBySession",
  "SE:CheckSEState",
  "SE:GetChannelType"
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
               target         : msg.target
               readerTypes    : [] // 'uicc','eSE'
               sessions       : { [11111 : // sessionId (Key 1)
                                          type :
                                          channels : { [aaaaa: // 'token' (key 1)
                                                               type:
                                                                aid :
                                                                channelNumber : ]
                                                        [bbbbb: // 'token' (key 2 )
                                                                type:
                                                                aid :
                                                                channelNumber : ]
                                                        [ccccc: // 'token' (key 3)
                                                                type:
                                                                aid :
                                                                channelNumber :]
                                                     }
                                  ]
                                  [22222 : // sessionId (key 2)
                                          type :
                                          channels : { [ddddd: // 'token' (key 1)
                                                              type:
                                                              aid :
                                                              channelNumber :]
                                                        [eeeee: // 'token' (key 2 )
                                                               type:
                                                               aid :
                                                               channelNumber : ]
                                                         [fffff: // 'token' (key 3)
                                                               type:
                                                               aid :
                                                               channelNumber :]
                                                      }
                                  ]
                                } // End of 'sessions'
       ]
       [ appId : // appId 2 (key)
                 ...
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

  _registerSETarget: function(message, readers) {
    let appInfoMap = this.appInfoMap;
    let appId = message.json.appId;
    let targetInfo = appInfoMap[appId];

    // If the application Id is already registered
    if (targetInfo) {
      debug("Already registered SE target! " + appId);
      return;
    }
    let newAppInfo = { target: message.target,
                       readerTypes: readers,
                       sessions: {} };
    appInfoMap[appId] = newAppInfo;
    if (DEBUG) debug("Registering a new SE target " + appId);
  },

  _unregisterSETarget: function(message) {
    let targets = this.appInfoMap;
    let appIdKeys = Object.keys(targets);

    for (let i = 0; i < appIdKeys.length; i++) {
      let appId = appIdKeys[i];
      let targetInfo = targets[appId];
      if (targetInfo && targetInfo.target === message.target) {
        // Remove the target from the list of registered targets
        if (DEBUG) debug("Unregisterd SE Target for AppId : " + appId);
        this._closeAllChannelsByAppId(appId, function(status) {
          if (status === SE.ERROR_GENERIC_FAILURE)
            debug("Err: Memory Leak? - Unable to CloseAll channels for AppId : " + appId);
          delete targets[appId];
        });
      }
    }
  },

  _removeAllSessions: function(msg) {
    let allSessions = this.appInfoMap[msg.appId].sessions;
    // reset all sessions
    if (allSessions)
      allSessions = {};
  },

  _addSession: function(sessionId, msg) {
    let appId = msg.appId;
    let type = msg.type;

    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      debug("Unable to add session: " + appId);
      return;
    }
    appInfo.sessions[sessionId] = { type: type,
                                    channels: {} };
  },

  _removeSession: function(msg) {
    let sessions = this.appInfoMap[msg.appId].sessions;
    if (sessions && sessions[msg.sessionId].type === msg.type)
      delete sessions[msg.sessionId];
  },

  _addChannel: function(channelInfo, msg) {
    let appId = msg.appId;
    let token = channelInfo.token;
    let status = SE.ERROR_GENERIC_FAILURE;

    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      debug("Unable to add channel: " + appId);
      return status;
    }
    let session = appInfo.sessions[msg.sessionId];
    if (!session) {
      debug("Unable to add channel: Inavlid session, " + msg.sessionId + " appId:" + appId);
      return status;
    }

    let channel = session.channels[token];
    // If channel with this 'token' is not yet added AND session type matches
    if (!channel && (session.type === msg.type)) {
      // Add the entry
      session.channels[token] = { type: channelInfo.type,
                                  aid: msg.aid,
                                  channel: channelInfo.channel };
      return SE.ERROR_SUCCESS;
    }
    if (DEBUG) debug("Unable to add channel: Type Mismatch - " + session.type + " Vs " +
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

  /* // Uncomment this function in order to debug the appInfoMap
  _debugMap: function(eventDesc) {
    debug("----------------------------------------------------------------------------------------");
    debug(eventDesc);
    let targets = this.appInfoMap;
    Object.keys(targets).forEach((appId) => {
      debug("appId : " + appId);
      debug("       target : " + targets[appId].target);
      let readerTypes = '';
      for (let index = 0; targets[appId].readerTypes &&
             (index < targets[appId].readerTypes.length); index++) {
        readerTypes += targets[appId].readerTypes[index] + ' ';
      }
      debug("       readerTypes : " + readerTypes);
      let sessions = targets[appId].sessions;
      Object.keys(sessions).forEach((sessionId) => {
        debug("       sessionId key : " + sessionId);
        debug("                      type : " + sessions[sessionId].type);
        let channels = sessions[sessionId].channels;
        Object.keys(channels).forEach((token) => {
          debug("                          token key : " + token);
          debug("                                    Type : " + channels[token].type);
          debug("                                    channelNumber : " + channels[token].channel);
          debug("                                    AID : " +
                                                      this._byteTohexString(channels[token].aid));
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
     debug(' In getAllChannelsByAppId ' + appId);
    if (!appInfo) {
      debug("Unable to get all channels : " + appId);
      return null;
    }
    let channelNumbers = new Array();
    let sessions = appInfo.sessions;
    let sessionKeys = Object.keys(sessions);
    for (let i = 0; i < sessionKeys.length; i++) {
      let aKey = sessionKeys[i];
      let channels = sessions[aKey].channels;
      if (channels) {
        channelNumbers = channelNumbers.concat(this._getChannels(channels));
        debug(' channelNumbers length ' + channelNumbers.length);
      }
    }
    return (channelNumbers.length > 0) ? channelNumbers : null;
  },

  _getChannelCountBySessionId: function(sessionId, appId) {
    let session = this.appInfoMap[appId].sessions[sessionId];
    if (!session) {
      debug("Unable to get channel count : " + appId + " sessionId: " + sessionId);
      return null;
    }
    return Object.keys(session.channels).length;
  },

  _getAllChannelsBySessionId: function(sessionId, appId) {
    let sessions = this.appInfoMap[appId].sessions[sessionId];
    if (!sessions) {
      debug("Unable to get all channels : " + appId + " sessionId: " + sessionId);
      return null;
    }
    return this._getChannels(sessions.channels);
  },

  _getChannels: function(channels) {
    if (!channels)
      return null;

    let channelNumbers = new Array();
    let channelKeys = Object.keys(channels);
    for (let i = 0; i < channelKeys.length; i++) {
      let channelNumber = channels[channelKeys[i]].channel;
      channelNumbers.push(channelNumber);
    }
    return (channelNumbers.length > 0) ? channelNumbers : null;
  },

  _getChannel: function(data) {
    return this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].channel;
  },

  _getChannelType: function(data) {
    return this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].type;
  },

  _getType: function(data) {
    return this.appInfoMap[data.appId].sessions[data.sessionId].type;
  },

  _isRegisteredForGivenType: function(type, data) {
    return (this._getType(data) === type);
  },

  _checkSEState: function(data) {
    let types = this.appInfoMap[data.appId].readerTypes;
    if (types.indexOf(data.type) > -1) {
      switch (data.type) {
        case SE.TYPE_UICC:
          return this._isUiccInReadyState();
        default:
          if (DEBUG) debug('Unsupported readerType ' + data.type + ' for appId ' + data.appId);
          break;
      }
    }
    return false;
  },

  _validateAID: function(aid, data) {
    let regAid =
      this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].aid;
    return this._compareAIDs(aid, regAid);
  },

  _compareAIDs: function(aid1, aid2) {
    return (this._byteTohexString(aid1) === this._byteTohexString(aid2));
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

  _openChannel: function(msg, callback) {
    let error = null;
    do {
      // Sanity Checks!
      if (!this._isValidSession(msg)) {
        error = "Invalid Session " + msg.sessionId + " for appId : " + msg.appId;
        break;
      }

      if (!this._isRegisteredForGivenType(msg.type,
                                          {appId: msg.appId, sessionId: msg.sessionId})) {
        error = "Invalid / Unregistered sessiond ID: " + msg.sessionId +
                " AND / OR AppId : " + msg.appId + " for the given type : " + msg.type;
        break;
      }

      if (!msg.aid || msg.aid.length === 0) {
        if (msg.type === SE.TYPE_UICC) {
          debug('AID is null for SE type: ' + SE.TYPE_UICC);
          // According to SIMalliance_OpenMobileAPI v3 draft, it is recommended not to support it
          error = "AID should not be null for 'uicc'";
          break;
        }
      } else if (msg.aid.length < SE.MIN_AID_LEN || msg.aid.length > SE.MAX_AID_LEN) {
        error = "Invalid AID length";
        break;
      }

      if (this._getChannelCountBySessionId(msg.sessionId, msg.appId) >=
            SE.MAX_CHANNELS_ALLOWED_PER_SESSION) {
        error = "Max channels per session exceed !!!";
        break;
      }

      // TBD: Validate the AID ""msg.aid" with ACE
    } while (false);

    if (error !== null) {
      if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      debug("Sanity Check fails for transmit command, Reason :- " + error);
      return;
    }

    if (msg.type === SE.TYPE_UICC)
      this._doUiccOpenChannel(msg, callback);
  },

  _doUiccOpenChannel: function(msg, callback) {
    let aidStr = this._byteTohexString(msg.aid);
    if (aidStr === "")
      aidStr = null; // If Null, and indeed no AID was passed, select the default applet is exists

    iccProvider.iccOpenChannel(PREFERRED_UICC_CLIENTID, aidStr, {
      notifyOpenChannelSuccess: function(channel) {
        // Now that we have received a 'channel', try to get the 'openResponse'
        gSEMessageManager._doGetResponse(channel, 0x00, function(result) {
          let token = UUIDGenerator.generateUUID().toString();
          let channelData = { channel: channel,
                              token: token,
                              type: SE.TYPE_LOGICAL_CHANNEL };
          let status = gSEMessageManager._addChannel(channelData, msg);
          if (callback) {
            callback({ status: result.status, token: token, openResponse: result.simResponse });
          }
        });
      },

      notifyError: function(error) {
        if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE,
                                 error: error, openResponse: [] });
      }
    });
  },

  _doGetResponse: function(channel, length, callback) {
    // cla: channel, ins: 0xC0, p1: 0x00, p2: 0x00, p3: 0x00 (length)
    let apduOpenRespBytes = new Uint8Array([(channel & 0xFF), SE.GET_RESPONSE, 0x00, 0x00, length]);
    // data is not set AND p3:0x00, is an indication to UICC card to get
    // all the available response bytes.
    this._doUiccTransmit(apduOpenRespBytes, function(result) {
      if (DEBUG) debug('GET Response : ' + result.simResponse);
      callback(result);
    });
  },

  _transmit: function(msg, callback) {
    let command = msg.apdu;
    let error = null;
    do {
      // Sanity Checks!
      if (!this._isValidSession(msg)) {
        error = "Invalid Session " + msg.sessionId + " for appId : " + msg.appId;
        break;
      }

      if (!this._validateAID(msg.aid, msg)) {
        error = "Invalid AID - " + msg.aid + ", [appId: " + msg.appId + ", sessionId: " +
                  msg.sessionId + ", token: " + msg.channelToken + " ]";
        break;
      }

      if (command.length > SE.MAX_APDU_LEN) {
        error = "Data length exceeds max limit - " + SE.MAX_APDU_LEN +
                " Extended APDU is not supported! : " + command.length;
        break;
      }

      if (command.length < SE.APDU_HEADER_LEN) {
        error: "command cannot be smaller than 4 bytes";
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

      // TBD: Validate the AID ""msg.aid" with ACE
    } while (false);

    if (error !== null) {
      if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      debug("Sanity Check fails for transmit command, Reason :- " + error);
      return;
    }

    // See GP Spec, 11.1.4 Class Byte Coding
    command[0] = this._setChannelToClassByte(command[0], this._getChannel(msg));

    let type = this._getType({appId: msg.appId, sessionId: msg.sessionId});
    if (type === SE.TYPE_UICC)
      this._doUiccTransmit(msg.apdu, callback);
  },

  _doUiccTransmit: function(apduCmd, callback) {
    let cla = apduCmd[SE.CLA_BYTE_OFFSET] & 0xFF;
    let ins = apduCmd[SE.INS_BYTE_OFFSET] & 0xFF;
    let p1 = apduCmd[SE.P1_BYTE_OFFSET] & 0xFF;
    let p2 = apduCmd[SE.P2_BYTE_OFFSET] & 0xFF;
    let p3 = !apduCmd[SE.P3_BYTE_OFFSET] ? 0 : apduCmd[SE.P3_BYTE_OFFSET] & 0xFF;

    // Check P3 > 0 AND the apdu length. The second condition is needed to explicitly
    // check if there are "data bytes' indeed. If there are no 'data bytes
    // (i;e; if apduCmd.length = '5' and P3 is > 0, implies 'P3'
    // shall still be interpreted as 'Le'.
    let data = ((p3 > 0) && (apduCmd.length > SE.DATA_BYTE_OFFSET)) ?
                this._byteTohexString(apduCmd.subarray(SE.DATA_BYTE_OFFSET)) : null;
    let channel = this._getChannelNumber(apduCmd[0] & 0xFF);
    if (DEBUG) debug("transmit on Channel # " + channel);

    // Pass empty response '[]' as args as we are not interested in appended responses yet!
    this._doIccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                            cla, ins, p1, p2, p3, data, [], callback);

  },

  _doIccExchangeAPDU: function(clientId, channel, cla, ins, p1, p2,
                               p3, data, appendResponse, callback) {
    let response = [];
    let self = this;

    iccProvider.iccExchangeAPDU(clientId, channel,
                                (cla & 0xFC), ins, p1, p2, p3, data, {
      notifyExchangeAPDUResponse: function(sw1, sw2, length, simResponse) {

        if (DEBUG) debug("sw1 : " + sw1 + ", sw2 : " + sw2 +
                         ", simResponse : " + self._byteTohexString(simResponse));
        // Copy the response
        response = (simResponse && simResponse.length > 0) ?
                   appendResponse.concat(simResponse) : appendResponse;

        // According to ETSI TS 102 221 , See section 7.2.2.3.1:
        // Enforce 'Procedure bytes' checks before notifying the callback. Note that
        // 'Procedure bytes'are special cases.

        // There is no need to handle '0x60' procedure byte as it implies no-action from SE
        // stack perspective. In any case this procedure byte is not notified to application
        // layer (?).
        if (sw1 === 0x6C) {
          // Use the previous command header with length as second procedure byte (SW2) as received
          // and repeat the procedure. i,e; '_doIccExchangeAPDU(...)'.
          if (DEBUG) debug("Enforce '0x6C' Procedure with sw2 : " + sw2);

          // Recursive! and Pass empty response '[]' as args, since '0x6C' procedure
          // does not have to deal with appended responses.
          self._doIccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                                  cla, ins, p1, p2, sw2, data, [], callback);
        } else if (sw1 === 0x61) {
          if (DEBUG) debug("Enforce '0x61' Procedure with sw2 : " + sw2);
          // Since the terminal waited for a second procedure byte and received it (sw2), send a
          // GET RESPONSE command header to the UICC with a maximum length of 'XX',
          // where 'XX' is the value of the second procedure byte (SW2).

          // Recursive, with GET RESPONSE bytes and '0x61' procedure IS interested in
          // appended responses.
          self._doIccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                                  (channel & 0xFF), SE.GET_RESPONSE, 0x00, 0x00, sw2, null,
                                  response, callback);
        } else if (callback) {
          callback({ status: SE.ERROR_SUCCESS, sw1: sw1, sw2: sw2, simResponse: response });
        }
      },

      notifyError: function(error) {
        if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error, simResponse: [] });
      }
    });
  },

  _closeChannel: function(msg, callback) {
    let error = null;
    do {
      // Sanity Checks!
      if (!this._isValidSession(msg)) {
        error = "Invalid Session " + msg.sessionId + " for appId : " + msg.appId;
        break;
      }

      if (!this._validateAID(msg.aid, msg)) {
        error = "Invalid AID - " + msg.aid + ", [appId: " + msg.appId +
                ", sessionId: " + msg.sessionId + ", token: " + msg.channelToken + " ]";
      }

      // TBD: Validate the AID ''msg.aid' with ACE
    } while (false);

    if (error !== null) {
      if (callback) callback({ status: SE.ERROR_GENERIC_FAILURE, error: error });
      return;
    }

    let type = this._getType({appId: msg.appId, sessionId: msg.sessionId});
    if (type === SE.TYPE_UICC)
      this._doUiccCloseChannel(this._getChannel(msg), callback);
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

      if (channelNumber === SE.TYPE_BASIC_CHANNEL) {
        debug("Basic Channel can never be closed!");
        status |= SE.ERROR_GENERIC_FAILURE;
        if (callback && (++count === channels.length))
          callback({ status: SE.ERROR_GENERIC_FAILURE,
                      error: "Basic Channel can never be closed!"});
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

  _checkAndRetrieveAvailableReaders: function() {
    let readers = [];
    if (this.cardReady) {
      readers.push(SE.TYPE_UICC);
    }
    return readers;
  },

  _canOpenSession: function(data) {
    return this._checkSEState(data);
  },

  _hexStringToBytes: function(hexString) {
    let bytes = [];
    let length = hexString.length;

    for (let i = 0; i < length; i += 2) {
      bytes.push(Number.parseInt(hexString.substr(i, 2), 16));
    }

    return bytes;
  },

  _byteTohexString: function(array) {
    let hexString = "";
    let hex;

    if (!array || array.length === 0)
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
    let options = msg.json ? { status: status,
                               resolverId: msg.json.resolverId } : { status: status };

    if (msg.name == "child-process-shutdown") {
      // By the time we receive child-process-shutdown, the child process has
      // already forgotten its permissions so we need to unregister the target
      // for every permission.
      this._unregisterSETarget(msg);
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
        let seReaders = this._checkAndRetrieveAvailableReaders();
        if (seReaders.length > 0) {
          this._registerSETarget(msg, seReaders);
          options = { readers: seReaders,
                      resolverId: msg.json.resolverId };
          promiseStatus = "Resolved";
        }
        break;
      case "SE:OpenSession":
        if (this._canOpenSession(msg.json)) {
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
                      openResponse: result.openResponse,
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
          gSEMessageManager._removeSession(message.json);
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
      case "SE:CheckSEState":
        return this._checkSEState(msg.json);
        break;
      case "SE:GetChannelType":
        return this._getChannelType(msg.json);
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
     if (DEBUG) debug("CardStateChanged - " + "CardReady ? " + this.cardReady);
   },

   notifyIccInfoChanged: function() {}
  };
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElement]);

