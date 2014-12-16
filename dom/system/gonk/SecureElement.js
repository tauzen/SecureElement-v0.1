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

// set to true in se_consts.js to see debug messages
let DEBUG = SE.DEBUG_SE;

function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement: " + s + "\n");
  }
}

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
  "SE:IsSEPresent",
  "SE:IsSessionClosed",
  "SE:GetChannelType",
  "SE:IsChannelClosed"
];

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
  gSecureElementManager.init(this);
}

SecureElement.prototype = {
  classID: SE_CID,
  classInfo: XPCOMUtils.generateCI({classID: SE_CID,
                  contractID: SE_CONTRACTID,
                  classDescription: "SecureElement",
                  interfaces: []})
};

// Factory constructor
function SEConnectorFactory() {}

/**
 * Factory like pattern for getting the Connector obj.
 * Each SEConnector type obj (say 'UiccConnector') shall expose
 * following public functions.
 * - doOpenChannel(aid, callback);
 * - doTransmit(apdu, callback);
 * - doCloseAll([channels], callback);
 * - isSEPresent()
 */
SEConnectorFactory.prototype = {

  connectorClass: null,

  get: function(options) {
    switch (options.type) {
      case SE.TYPE_ESE:
        if (DEBUG) debug('UnSupported SEConnector : ' + SE.TYPE_ESE);
        break;
      case SE.TYPE_UICC:
      default: // Default ConnectorClass is UiccConnector
        this.connectorClass = UiccConnector;
        break;
    }
    return this.connectorClass;
  }
};

/**
 * 'gMap' is a nested dictionary object that mananges all the necessary information
 * pertainining to multiple sessions and channels for a given application (appId).
 * An application (appId / content) can open multiple sessions.
 * In turn each session can open multiple channels with the secure element.
 * Following are its (key,value) attributes and brief description :
 * (key)'appId'    : Key used mainly to retrieve the 'session obj' (sessions).
 * 'target'        : Target obj that identifies the content target to notify to
 * 'readerTypes'   : Types ('uicc' / 'eSE') that are available to the
                     application (appId)
 * 'sessions'      : Dictionary obj that holds all the sessions opened
                     by the application (appId)
 * (key)'sessionId': Key used to retrieve the 'session info ' such as
                     'type' & 'channels'
 * 'type'          : Session type indicating 'uicc' (or) 'eSE'
 * 'channels'      : Dictionary obj that holds all the channels opened by the session.
 * (key)'token'    : Key used to retrieve 'channel info' such as 'aid' ,
                     'channel Number'
 *                   and the 'type' of channel
 * 'type'          : Channel type indicating if it is 'logical' / 'basic'
 * 'aid'           : AID that identifies the opened channel.
 * 'channelNumber' : The channel number that was returned by lower layers upon
                     successfully opening a channel
 */
XPCOMUtils.defineLazyGetter(this, "gMap", function() {
  return {

    /*
    ------------------------------
       Structure of 'appInfoMap':
    ------------------------------
    {  [ appId :// (key = '1020')
               target         : msg.target
               readerTypes    : [] // 'uicc','eSE'
               sessions       : { [sessionId : // (key = '1111')
                                             type :
                                             channels : { [token: // (key = 'aaaaa')
                                                                 type:
                                                                 aid :
                                                                 channelNumber : ]
                                                          [token: // (key = 'bbbbb')
                                                                 type:
                                                                 aid :
                                                                 channelNumber : ]
                                                          [token: // (key = 'ccccc')
                                                                 type:
                                                                 aid :
                                                                 channelNumber :]
                                                        }
                                  ]
                                  [sessionId : // (key = '22222')
                                             type :
                                             channels : { [token: // (key = 'ddddd')
                                                                 type:
                                                                 aid :
                                                                 channelNumber :]
                                                          [token: // (key = 'eeeee')
                                                                 type:
                                                                 aid :
                                                                 channelNumber : ]
                                                          [token: // (key = 'fffff')
                                                                 type:
                                                                 aid :
                                                                 channelNumber :]
                                                        }
                                  ]
                                } // End of 'sessions'
       ]
       [ appId : // (key = '1025')
                 ...
                 ...
                 ...
       ]
    } */
    appInfoMap: {},

    /**
     * Application (appId) related functions
     */

    // Register the new SecureElement target.
    registerSecureElementTarget: function(message, readers) {
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

    // UnRegister the SecureElement target.
    unregisterSecureElementTarget: function(message) {
      let targets = this.appInfoMap;
      let appIdKeys = Object.keys(targets);

      for (let i = 0; i < appIdKeys.length; i++) {
        let appId = appIdKeys[i];
        let targetInfo = targets[appId];
        if (targetInfo && targetInfo.target === message.target) {
          // Remove the target from the list of registered targets
          if (DEBUG) debug("Unregisterd SE Target for AppId : " + appId);
          // No need to pass the callback function.
          gSecureElementManager.closeAllChannelsByAppId({appId: appId}, null);
          delete targets[appId];
        }
      }
    },

    // Gets all the channels in an array for the given appId
    getAllChannelsByAppId: function(appId) {
      let channelNumbers = [];
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channels : " + appId);
        return channelNumbers;
      }
      let sessions = appInfo.sessions;
      let sessionKeys = Object.keys(sessions);
      for (let i = 0; i < sessionKeys.length; i++) {
        let aKey = sessionKeys[i];
        let channels = sessions[aKey].channels;
        if (channels) {
          channelNumbers = channelNumbers.concat(this._getChannels(channels));
        }
      }
      return channelNumbers;
    },

    /**
     * Reader related functions
     */

    // Gets all the channels in an array for the given readerType
    getAllChannelsByReaderType: function(type, appId) {
      let channelNumbers = [];
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channels : " + appId);
        return channelNumbers;
      }
      let sessions = appInfo.sessions;
      let sessionKeys = Object.keys(sessions);
      for (let i = 0; i < sessionKeys.length; i++) {
        let aKey = sessionKeys[i];
        // If types don't match , move to the next sessionKey
        if (sessions[aKey].type !== type)
          continue;
        let channels = sessions[aKey].channels;
        if (channels) {
          channelNumbers = channelNumbers.concat(this._getChannels(channels));
        }
      }
      return channelNumbers;
    },

    // Checks if the 'readerType' is a registered / supported one or not for
    // the given 'appId'
    isSupportedReaderType: function(data) {
      let types = this.appInfoMap[data.appId].readerTypes;
      return (types.indexOf(data.type) > -1);
    },

    /**
     * Session related functions
     */

    // Add a new sessionId for a given appId
    addSession: function(sessionId, msg) {
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

    // Remove the sessionId from given appId
    removeSession: function(msg) {
      let sessions = this.appInfoMap[msg.appId].sessions;
      if (sessions[msg.sessionId].type === msg.type)
        delete sessions[msg.sessionId];
    },

    // Removes / Resets all sessions for a given appId.
    removeAllSessions: function(msg) {
      let allSessions = this.appInfoMap[msg.appId].sessions;
      // reset all sessions
      if (allSessions)
        allSessions = {};
    },

    // Returns false if the sessionId entry is present in the map.
    // It implies that the session is active. If the entry is not
    // found in the map, it returns true.
    isSessionClosed: function(data) {
      return !this.appInfoMap[data.appId].sessions[data.sessionId];
    },

    // Returns true if the session can be established, otherwise false
    // First check if it is a valid 'type' and check if the 'type' is present or not.
    // For ex:- If a SIM card is not inserted , 'session' cannot be established
    canOpenSession: function(data) {
      return this.isSupportedReaderType(data) &&
             gSecureElementManager.connectorFactory.get({type: data.type}).isSEPresent();
    },

    // Returns true if the given sessionId is already registered / valid one,
    // else returns false
    isValidSession: function(data) {
      return (this.appInfoMap[data.appId].sessions[data.sessionId] ? true : false);
    },

    // Get the Session Type : ('uicc' / 'eSE') for a given (appId, sessionId)
    getSessionType: function(data) {
      return this.appInfoMap[data.appId].sessions[data.sessionId].type;
    },

    // Gets channel count associated with the 'sessionId'
    getChannelCountBySessionId: function(sessionId, appId) {
      let session = this.appInfoMap[appId].sessions[sessionId];
      if (!session) {
        debug("Unable to get channel count : " + appId + " sessionId: " + sessionId);
        return 0;
      }
      return Object.keys(session.channels).length;
    },

    // Gets all the channels associated with the 'sessionId'
    getAllChannelsBySessionId: function(sessionId, appId) {
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channels for sesssionId: " + sessionId + ", AppId : " + appId);
        return [];
      }
      let sessions = appInfo.sessions[sessionId];
      if (!sessions) {
        debug("Unable to get all channels : " + appId + " sessionId: " + sessionId);
        return [];
      }
      return this._getChannels(sessions.channels);
    },

    /**
     * channel related functions
     */

    // Add new channel to a given sessionId. Upon successfully adding the entry
    // this function will return the 'token'
    addChannel: function(channelNumber, msg) {
      let status = SE.ERROR_GENERIC;
      let appId = msg.appId;
      // Generate a unique 'token' (alias) instead of sending the actual 'channel number'.
      // to the content. Any further 'Channel' related operations by the content
      // shall operate using this token.
      let token = UUIDGenerator.generateUUID().toString();

      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to add channel: " + appId);
        return null;
      }
      let session = appInfo.sessions[msg.sessionId];
      if (!session) {
        debug("Unable to add channel: Inavlid session, " + msg.sessionId +
              " appId:" + appId);
        return null;
      }

      // Add if 'type' matches
      if (session.type !== msg.type) {
        if (DEBUG) debug("Unable to add channel: Type Mismatch - " + session.type +
                         " Vs " + msg.type + " (or) Channel already added:" +
                         channelNumber + " " + session.channels[token].channel);
        return null;
      }
      // Add the entry
      session.channels[token] = { type: SE.TYPE_LOGICAL_CHANNEL,
                                  aid: msg.aid,
                                  channel: channelNumber };
      return token;
    },

    // Remove the given 'channelNumber' entry based on type.
    // Note that 'channelNumber' will be unique per type
    removeChannel: function(channelNumber, type) {
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

    // Returns false if the channel entry is present in the map. It implies that the
    // channel is still open. If the entry is not found in the map, it returns true.
    isChannelClosed: function(data) {
      return !this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken];
    },


    // Validates the given 'aid' by comparing the it with the one already
    // registered for the given (appId, sessionId, channelToken)
    isValidAID: function(aid, data) {
      let regAid =
        this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].aid;
      return this._compareAIDs(aid, regAid);
    },

    // Get the 'channel' associated for a given (appId, sessionId, channelToken)
    getChannel: function(data) {
      return this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].channel;
    },

    // Get the 'channel type : (logical / basic)' for a
    // given (appId, sessionId, channelToken)
    getChannelType: function(data) {
      return this.appInfoMap[data.appId].sessions[data.sessionId].channels[data.channelToken].type;
    },

    /*
     * Private internal functions
     */

    // Retrieves all the channels for the given 'channels' object
    _getChannels: function(channels) {
      if (!channels)
        return null;

      let channelNumbers = new Array();
      let channelKeys = Object.keys(channels);
      for (let i = 0; i < channelKeys.length; i++) {
        let channelNumber = channels[channelKeys[i]].channel;
        debug('Channel number ' + channelNumber);
        channelNumbers.push(channelNumber);
      }
      return (channelNumbers.length > 0) ? channelNumbers : null;
    },

    _compareAIDs: function(aid1, aid2) {
      return (SE.gUtils.byteTohexString(aid1) === SE.gUtils.byteTohexString(aid2));
    }

    /*
    // Uncomment this function in order to debug the 'gMap'.
    log: function(event) {
      debug("----------------------------------------------------------------------");
      debug(event + ":");
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
                                                        SE.gUtils.byteTohexString(channels[token].aid));
          }); // End of Channels keys
        }); // End of Sessions keys
      }); // End of AppId keys
      debug("----------------------------------------------------------------------");
    },*/
  };
});

/**
 * 'UiccConnector' object is a wrapper over iccProvider's channel management
 * related interfaces. It also implements 'nsIIccListener' to monitor the state of
 * 'uicc' card. It exposes two helper functions to start / stop monitoring
 * the uicc card state changes.
 */
XPCOMUtils.defineLazyGetter(this, "UiccConnector", function() {
  return {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIIccListener]),

    _isUiccSecureElementPresent: false,

   /**
     * nsIIccListener interface methods.
     */
    notifyStkCommand: function() {},

    notifyStkSessionEnd: function() {},

    notifyCardStateChanged: function() {
      this._isUiccSecureElementPresent = this._getCardState();
      if (DEBUG) debug("CardStateChanged! " + "Uicc Present : " +
                       this._isUiccSecureElementPresent);
    },

    notifyIccInfoChanged: function() {},

    // This function acts as a trigger to listen on 'nsIIccListener' callbacks
    start: function() {
      if (DEBUG) debug("Default Client ID " + PREFERRED_UICC_CLIENTID);
      iccProvider.registerIccMsg(PREFERRED_UICC_CLIENTID, this);

      // Update the state in order to avoid race condition.
      // By this time, 'notifyCardStateChanged' could have happened
      this._isUiccSecureElementPresent = this._getCardState();
    },

    stop: function() {
      // Detach the listener to UICC state changes
      iccProvider.unregisterIccMsg(PREFERRED_UICC_CLIENTID, this);
    },

    isSEPresent: function() {
      return this._isUiccSecureElementPresent;
    },

    doOpenChannel: function(aid, callback) {
      if (!aid || aid.length === 0) {
        // According to SIMalliance_OpenMobileAPI v3 draft,
        // it is recommended not to support it.
        debug('AID is not set. Reject the openChannel request!');
        throw new Error(SE.ERROR_SECURITY);
      }

      if (aid.length < SE.MIN_AID_LEN || aid.length > SE.MAX_AID_LEN) {
        debug("Invalid AID length : " + aid.length);
        throw new Error(SE.ERROR_GENERIC);
      }

      // TBD: Finally Perform checks with ACE module

      let aidStr = SE.gUtils.byteTohexString(aid);
      let self = this;
      iccProvider.iccOpenChannel(PREFERRED_UICC_CLIENTID, aidStr, {
        notifyOpenChannelSuccess: function(channel) {
          self._doGetOpenResponse(channel, 0x00, function(result) {
            if (callback) {
              callback({ status: SE.ERROR_NONE, channel: channel,
                         openResponse: result.simResponse });
            }
          });
        },

        notifyError: function(error) {
          debug('Failed to open the channel to AID : ' + aidStr +
                ', Rejected with Reason : ' + error);
          if (callback) callback({ status: SE.ERROR_INVALIDAPPLICATION,
                                   error: error });
        }
      });
    },

    doTransmit: function(command, callback) {
      let cla = command.cla & 0xFF;
      let ins = command.ins & 0xFF;
      let p1 = command.p1 & 0xFF;
      let p2 = command.p2 & 0xFF;

      let appendLe = false;
      // Note that P3 of the C-TPDU is set to ‘00’ in Case 1 (only headers) scenarios
      let p3 = 0x00;
      // Determine p3
      if (command.data !== null && command.le !== -1) {
        // In case both data and le are set, (case 4) then 'p3 = data length'
        p3 = command.data.length;
        appendLe = true;
      } else if (command.data !== null ) {
        // Only data is set, 'p3=lc / data length'
        p3 = command.data.length; // lc
      }
      else if (command.le !== -1) {
        // Only le is set. 'p3=le'. Response expected!
        p3 = command.le;
      }

      // At this point perform more sanity checks on the c-apdu
      if (p3 + SE.APDU_HEADER_LEN > SE.MAX_APDU_LEN) {
        debug("Data length exceeds max limit - " + SE.MAX_APDU_LEN +
              " Extended APDU is not supported! : " + command.length);
        throw new Error(SE.ERROR_GENERIC);
      }

      // Check for mandatory headers!
      if (typeof command.cla === 'undefined' ||
          typeof command.ins === 'undefined' ||
          typeof command.p1 === 'undefined' ||
          typeof command.p2 === 'undefined') {
        debug('Mandatory command headers Missing! - Invalid Command');
        throw new Error(SE.ERROR_IO);
      }

      if (((cla & (0xFF & 0x80) === 0)) &&
          ((0xFF & (cla & (0xFF & 0x60))) !== (0xFF & 0x20))) {
        if (ins === (0xFF & SE.INS_MANAGE_CHANNEL)) {
          debug("MANAGE CHANNEL command not permitted");
          throw new Error(SE.ERROR_SECURITY);
        }
        if ((ins === (0xFF & SE.INS_SELECT)) && (p1 == (0xFF & 0x04))) {
          // SELECT by DF Name (p1=04) is not allowed
          debug("SELECT command not permitted");
          throw new Error(SE.ERROR_SECURITY);
        }
        if (DEBUG) debug("Attempting to transmit an ISO command");
      } else {
        if (DEBUG) debug("Attempting to transmit GlobalPlatform command");
      }

      // TBD: Finally Perform checks with ACE module

      let data = null;
      // Check p3 > 0 AND the command.data length > 0. The second condition is
      // needed to explicitly check if there are 'data bytes' indeed. If there
      // are no 'data bytes' then 'p3' will be interpreted as 'Le'.
      if ((p3 > 0) && (command.data.length > 0) && (command.data.length < SE.MAX_APDU_LEN)) {
        let commandData = new Uint8Array(p3);
        let offset = 0;
        while (offset < SE.MAX_APDU_LEN && offset < p3) {
          commandData[offset] = command.data[offset];
          offset++;
        }
        data = SE.gUtils.byteTohexString(commandData);
      }
      if (data && appendLe) {
        // Append 'le' value to data
        let leHexStr = SE.gUtils.byteTohexString(le & 0xFF) +
                       SE.gUtils.byteTohexString((le >> 8) & 0xFF) ;
        data += leHexStr;
      }
      let channel = this._getChannelNumber(cla & 0xFF);
      if (DEBUG) debug("transmit on Channel # " + channel);

      // Pass empty response '' as args as we are not interested in appended
      // responses yet!
      this._doIccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                              cla, ins, p1, p2, p3, data, '', callback);

    },

    doCloseChannel: function(channelNumber, callback) {
      this.doCloseAll([channelNumber],
                       callback);
    },

    doCloseAll: function(channels, callback) {
      let closedChannels = [];
      if (!channels || channels.length === 0) {
        if (callback)
          callback({ status: SE.ERROR_GENERIC, channels: closedChannels,
                     error: "No Active Channels to be closed!"});
        return;
      }

      // TBD: Finally Perform checks with ACE module

      let count = 0;
      for (let index = 0; index < channels.length; index++) {
        let channelNumber = channels[index];
        if (channelNumber === SE.TYPE_BASIC_CHANNEL) {
          if (DEBUG) debug("Basic Channel can never be closed!");
          if (callback && (++count === channels.length))
            callback({ status: SE.ERROR_GENERIC,
                        error: "Basic Channel can never be closed!"});
        }

        if (!channelNumber) continue;
        if (DEBUG) debug("Attempting to Close Channel # : " + channelNumber);

        iccProvider.iccCloseChannel(PREFERRED_UICC_CLIENTID, channelNumber, {
          notifyCloseChannelSuccess: function() {
            if (DEBUG) debug("notifyCloseChannelSuccess # : " + channelNumber);
            closedChannels.push(channelNumber);
            if (callback && (++count === channels.length)) {
              callback({ status: SE.ERROR_NONE, channels: closedChannels });
            }
          },

          notifyError: function(error) {
            debug('Failed to close the channel #  : ' + channelNumber +
                  ', Rejected with Reason : ' + error);
            if (callback && (++count === channels.length))
              callback({ status: ERROR_BADSTATE, channels: closedChannels,
                                                         error: error });
          }
        });
      }
    },

    setChannelToClassByte(cla, channelNumber) {
      if (channelNumber < 4) {
        // b7 = 0 indicates the first interindustry class byte coding
        cla = (((cla & 0x9C) & 0xFF) | channelNumber);
      } else if (channelNumber < 20) {
        // b7 = 1 indicates the further interindustry class byte coding
        cla = (((cla & 0xB0) & 0xFF) | 0x40 | (channelNumber - 4));
      } else {
        debug("Channel number must be within [0..19]");
        return SE.ERROR_GENERIC;
      }
      return cla;
    },

    // Following are the private functions

    _doGetOpenResponse: function(channel, length, callback) {
      let openResponseCommand = {
        cla: channel & 0xFF,
        ins: SE.INS_GET_RESPONSE,
        p1: 0x00,
        p2: 0x00,
        p3: length, //Indicate to UICC card to get all the available response bytes.
        data: null
      };
      this.doTransmit(openResponseCommand, function(result) {
        if (DEBUG) debug('GET Response : ' + result.simResponse);
        if (callback) callback(result);
      });
    },

    _doIccExchangeAPDU: function(clientId, channel, cla, ins, p1, p2,
                                 p3, data, appendResponse, callback) {
      let response = '';
      let self = this;

      iccProvider.iccExchangeAPDU(clientId, channel,
                                  (cla & 0xFC), ins, p1, p2, p3, data, {
        notifyExchangeAPDUResponse: function(sw1, sw2, simResponse) {

          if (DEBUG) debug("sw1 : " + sw1 + ", sw2 : " + sw2 +
                           ", simResponse : " + simResponse);

          // Copy the response
          response = (simResponse && simResponse.length > 0) ?
                      simResponse + appendResponse : appendResponse;

          // According to ETSI TS 102 221 , See section 7.2.2.3.1:
          // Enforce 'Procedure bytes' checks before notifying the callback. Note that
          // 'Procedure bytes'are special cases.

          // There is no need to handle '0x60' procedure byte as it implies
          // no-action from SE stack perspective. In any case this procedure byte is not
          // notified to application layer (?).
          if (sw1 === 0x6C) {
            // Use the previous command header with length as second procedure byte (SW2)
            // as received and repeat the procedure. i,e; '_doIccExchangeAPDU(...)'.
            if (DEBUG) debug("Enforce '0x6C' Procedure with sw2 : " + sw2);

            // Recursive! and Pass empty response '' as args, since '0x6C' procedure
            // does not have to deal with appended responses.
            self._doIccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                                    cla, ins, p1, p2, sw2, data, '', callback);
          } else if (sw1 === 0x61) {
            if (DEBUG) debug("Enforce '0x61' Procedure with sw2 : " + sw2);
            // Since the terminal waited for a second procedure byte and received
            // it (sw2), send a GET RESPONSE command header to the UICC with a maximum
            // length of 'XX', where 'XX' is the value of the second procedure byte (SW2).

            // Recursive, with GET RESPONSE bytes and '0x61' procedure IS interested in
            // appended responses.
            self._doIccExchangeAPDU(PREFERRED_UICC_CLIENTID, channel,
                                    (channel & 0xFF), SE.INS_GET_RESPONSE, 0x00, 0x00, sw2, null,
                                    response, callback);
          } else if (callback) {
            callback({ status: SE.ERROR_NONE, sw1: sw1, sw2: sw2,
                       simResponse: SE.gUtils.hexStringToBytes(response) });
          }
        },

        notifyError: function(error) {
          debug('Failed to trasmit C-APDU over the channel #  : ' + channel +
                ', Rejected with Reason : ' + error);
          if (callback) callback({ status: SE.ERROR_IO, error: error, simResponse: [] });
        }
      });
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
        // Refer to section  11.1.4.2.
        // Note that Supplementary Logical Channels start from 4 to 19. So add 4!
        return (cla & 0x0F) + 4;
      }
    },

    // Internal private function to retrieve the Uicc state
    _getCardState: function() {
      // Consider following Card states as not quite ready for issuing IccChannel* related commands
      let notReadyStates = [
        "unknown",
        "illegal",
        "personalizationInProgress",
        "permanentBlocked"
      ];
      let cardState = iccProvider.getCardState(PREFERRED_UICC_CLIENTID);
      return (((cardState !== null) && (notReadyStates.indexOf(cardState) == -1)) ? true : false);
    }
  };
});

/**
 * 'gSecureElementManager' is the main object that interfaces with
 * child process / content. It is also message manager of the module.
 * It also interacts with other objects such as 'gMap' & 'Connector instances
 * (UiccConnector, eSEConnector)' to perform various operations.
 * It mainly interacts with 'gMap' to query the state of Readers, Sessions, Channels,
 * while it interacts with 'Connector instances' to perform low level SE-related
 * (open,close,transmit) I/O operations.
 */
XPCOMUtils.defineLazyGetter(this, "gSecureElementManager", function() {
  return {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIMessageListener,
                                           Ci.nsIObserver]),

    secureelement: null,

    connectorFactory: null,

    init: function(secureelement) {
      this.secureelement = secureelement;
      Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
      this._registerMessageListeners();
      // This is needed for UiccConnector to start listening on uicc state changes
      UiccConnector.start();
      this.connectorFactory = new SEConnectorFactory();
    },

    _shutdown: function() {
      this.secureelement = null;
      this.connectorFactory = null;
      Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
      UiccConnector.stop();
      this._unregisterMessageListeners();
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

    _checkErrorsForOpenChannel(msg) {
      let error = SE.ERROR_NONE;
      if (!gMap.isValidSession(msg)) {
        debug("OpenChannel: Invalid Session " + msg.sessionId +
              " for appId : " + msg.appId);
        return SE.ERROR_GENERIC;
      }

      if (gMap.getChannelCountBySessionId(msg.sessionId, msg.appId) >=
            SE.MAX_CHANNELS_ALLOWED_PER_SESSION) {
        debug("Max channels per session exceed !!!");
        return SE.ERROR_GENERIC;
      }

      return error;
    },

    _checkErrorsForTransmit(msg) {
      let error = SE.ERROR_NONE;
      if (!gMap.isValidSession(msg)) {
        debug("Transmit: Invalid Session " + msg.sessionId +
              " for appId : " + msg.appId);
        return SE.ERROR_GENERIC;
      }

      if (!gMap.isValidAID(msg.aid, msg)) {
        debug("Invalid AID - " + msg.aid + ", [appId: " + msg.appId + ", sessionId: " +
               msg.sessionId + ", token: " + msg.channelToken + " ]");
        return SE.ERROR_GENERIC;
      }
      return error;
    },

    _checkErrorsForCloseChannel(msg) {
      let error = SE.ERROR_NONE;
      if (!gMap.isValidSession(msg)) {
        debug("CloseChannel: Invalid Session " + msg.sessionId +
              " for appId : " + msg.appId);
        return SE.ERROR_GENERIC;
      }

      if (!gMap.isValidAID(msg.aid, msg)) {
        debug("Invalid AID - " + msg.aid + ", [appId: " + msg.appId +
              ", sessionId: " + msg.sessionId + ", token: " + msg.channelToken + " ]");
        return SE.ERROR_GENERIC;
      }
      return error;
    },

    // Private function used to retreive available readerNames
    _checkAndRetrieveAvailableReaders: function() {
      // TBD: Return the list of readers only if the calling application has
      // the permissions to connect to.
      let readers = [];
      let uiccConnectorObj = this.connectorFactory.get({type: SE.TYPE_UICC});
      if (uiccConnectorObj.isSEPresent()) {
        // TBD: Slot based readerNames support. Instead of returning 'uicc',
        // return 'uicc<slot#>' etc...
        readers.push(SE.TYPE_UICC);
      }
      return readers;
    },

    _closeAll: function(type, channels, callback) {
      let connector = this.connectorFactory.get({type: type});
      connector.doCloseAll(channels, function(result) {
        // Remove all the channel entries from the map, since these channels have
        // been successfully closed
        for (let i = 0; i < result.channels.length; i++) {
          gMap.removeChannel(result.channels[i], type);
        }
        // Do not expose removed channels to content
        delete result.channels;
        if (callback) callback(result);
      });
    },

    openChannel: function(msg, callback) {
      // Perform Sanity Checks!
      let error = this._checkErrorsForOpenChannel(msg);
      if (error !== SE.ERROR_NONE) {
        if (callback) callback({ status: error });
        return;
      }

      // Sanity passed! Create Connector obj based on the 'type'
      let connector = this.connectorFactory.get({type: msg.type});
      try {
        connector.doOpenChannel(msg.aid, function(result) {
          if (result.status === SE.ERROR_NONE) {
            // Add the new 'channel' to the map upon success
            let channelToken = gMap.addChannel(result.channel, msg);
            // Add the new (key,value) pair to result!
            result['channelToken'] = channelToken;
          }
          if (callback) callback(result);
        });
      } catch (error) {
        if (DEBUG) {
          debug("Exception thrown while 'doOpenChannel' "+ error);
          if (callback) callback({ status: error });
        }
      }
    },

    transmit: function(msg, callback) {
      // Perform basic sanity checks!
      let error = this._checkErrorsForTransmit(msg);
      if (error !== SE.ERROR_NONE) {
        if (callback) callback({ status: error });
        return;
      }

      // Create Connector obj based on the 'type'
      let type = gMap.getSessionType({appId: msg.appId, sessionId: msg.sessionId});
      let connector = this.connectorFactory.get({type: type});

      // Set the channel to CLA before calling connector's doTransmit.
      // See GP Spec, 11.1.4 Class Byte Coding
      let channel = gMap.getChannel(msg);
      // Use connector to set the class byte
      msg.apdu.cla = connector.setChannelToClassByte(msg.apdu.cla, channel);
      try {
        connector.doTransmit(msg.apdu, callback);
      } catch (error) {
        if (DEBUG) {
          debug("Exception thrown while 'doTransmit' "+ error);
          if (callback) callback({ status: error });
        }
      }
    },

    closeChannel: function(msg, callback) {
      // Perform Sanity Checks!
      let error = this._checkErrorsForCloseChannel(msg);
      if (error !== SE.ERROR_NONE) {
        if (callback) callback({ status: error });
        return;
      }

      // Sanity passed! Create Connector obj based on the 'type'
      let type = gMap.getSessionType({appId: msg.appId, sessionId: msg.sessionId});
      return this._closeAll(type, [gMap.getChannel(msg)], callback);
    },

    // Closes all the channels opened by a session
    closeAllChannelsBySessionId: function(data, callback) {
      return this._closeAll(data.type,
        gMap.getAllChannelsBySessionId(data.sessionId, data.appId), callback);
    },

    // Closes all the channels opened by the reader
    closeAllChannelsByReader: function(data, callback) {
      return this._closeAll(data.type,
        gMap.getAllChannelsByReaderType(data.type, data.appId), callback);
    },

    closeAllChannelsByAppId: function(data, callback) {
      return this._closeAll(data.type,
        gMap.getAllChannelsByAppId(data.appId), callback);
    },

    /**
     * nsIMessageListener interface methods.
     */

    receiveMessage: function(msg) {
      if (DEBUG) debug("Received '" + msg.name + "' message from content process" + ": " +
                       JSON.stringify(msg.json));
      let status = SE.ERROR_GENERIC;
      let message = msg;
      let promiseStatus = "Rejected";
      let options = { status: status,
                                 resolverId: msg.json ? msg.json.resolverId : null };

      if (msg.name == "child-process-shutdown") {
        // By the time we receive child-process-shutdown, the child process has
        // already forgotten its permissions so we need to unregister the target
        // for every permission.
        gMap.unregisterSecureElementTarget(msg);
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

      switch (msg.name) {
        case "SE:GetSEReaders":
          let seReaders = this._checkAndRetrieveAvailableReaders();
          if (seReaders.length > 0) {
            gMap.registerSecureElementTarget(msg, seReaders);
            options = { readers: seReaders,
                        resolverId: msg.json.resolverId };
            promiseStatus = "Resolved";
          }
          break;
        case "SE:OpenSession":
          if (gMap.canOpenSession(msg.json)) {
            promiseStatus = "Resolved";
            status = SE.ERROR_NONE;
          }
          // Generate a unique sessionID and send it to content. All the subsequent
          // operations may happen on this session.
          let sessionId = UUIDGenerator.generateUUID().toString();
          gMap.addSession(sessionId, msg.json);
          options = { status: status,
                      sessionId: sessionId,
                      type: msg.json.type,
                      resolverId: msg.json.resolverId };
          break;
        case "SE:OpenChannel":
          this.openChannel(msg.json, function(result) {
            promiseStatus = (result.status === SE.ERROR_NONE) ? "Resolved" : "Rejected";
            options = { status: result.status,
                        aid: message.json.aid,
                        channelToken: result.channelToken,
                        openResponse: result.openResponse,
                        sessionId: message.json.sessionId,
                        resolverId: message.json.resolverId
                      };
            message.target.sendAsyncMessage(message.name + promiseStatus, options);
          });
          // Send the response from the callback, for now return!
          return;
        case "SE:TransmitAPDU":
          this.transmit(msg.json, function(result) {
            promiseStatus = (result.status === SE.ERROR_NONE) ? "Resolved" : "Rejected";
            options = { status: result.status,
                        channelToken: message.json.channelToken,
                        respApdu: result,
                        resolverId: message.json.resolverId
                      };
            message.target.sendAsyncMessage(message.name + promiseStatus, options);
          });
          // Send the response from the callback, for now return!
          return;
        case "SE:CloseChannel":
          this.closeChannel(msg.json, function(result) {
            promiseStatus = (result.status === SE.ERROR_NONE) ? "Resolved" : "Rejected";
            message.target.sendAsyncMessage(message.name + promiseStatus, message.json);
          });
          // Send the response from the callback, for now return!
          return;
        case "SE:CloseAllBySession":
          this.closeAllChannelsBySessionId(msg.json.sessionId,
                                           msg.json.appId, function(result) {
            promiseStatus = (result.status === SE.ERROR_NONE) ? "Resolved" : "Rejected";
            gMap.removeSession(message.json);
            options = { status: result.status,
                        sessionId: message.json.sessionId,
                        resolverId: message.json.resolverId };
            message.target.sendAsyncMessage(message.name + promiseStatus, options);
          });
          // Send the response from the callback, for now return!
          return;
        case "SE:CloseAllByReader":
          this.closeAllChannelsByReader(msg.json, function(result) {
            promiseStatus = (result.status === SE.ERROR_NONE) ? "Resolved" : "Rejected";
            gMap.removeAllSessions(message.json);
            options = { status: result.status,
                        type: message.json.type,
                        resolverId: message.json.resolverId };
            message.target.sendAsyncMessage(message.name + promiseStatus, options);
          });
          // Send the response from the callback, for now return!
          return;
        case "SE:IsSEPresent":
          return gMap.isSupportedReaderType(msg.json) &&
                 this.connectorFactory.get({type: msg.json.type}).isSEPresent();
        case "SE:IsSessionClosed":
          return gMap.isSessionClosed(msg.json);
        case "SE:GetChannelType":
          return gMap.getChannelType(msg.json);
        case "SE:IsChannelClosed":
          return gMap.isChannelClosed(msg.json);
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
    }
  };
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElement]);

