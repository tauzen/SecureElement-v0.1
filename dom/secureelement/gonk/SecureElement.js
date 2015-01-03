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

/* Copyright © 2015, Deutsche Telekom, Inc. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement: " + s + "\n");
  }
}

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");

XPCOMUtils.defineLazyGetter(this, "SE", function() {
  let obj = {};
  Cu.import("resource://gre/modules/se_consts.js", obj);
  return obj;
});

XPCOMUtils.defineLazyModuleGetter(this, "SEUtils",
                                  "resource://gre/modules/SEUtils.jsm");

// set to true in se_consts.js to see debug messages
let DEBUG = SE.DEBUG_SE;

// TODO: Bug 1118099  - Add multi-sim support.
// In the Multi-sim, there is more than one client.
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
  "SE:IsSEPresent"
];

const SECUREELEMENTMANAGER_CONTRACTID = "@mozilla.org/secureelement/manager;1";
const SECUREELEMENTMANAGER_CID =
  Components.ID("{48f4e650-28d2-11e4-8c21-0800200c9a66}");
const NS_XPCOM_SHUTDOWN_OBSERVER_ID = "xpcom-shutdown";

const SECUREELEMENTCONNECTOR_CONTRACTID = "@mozilla.org/secureelement/connector;1";
const SECUREELEMENTCONNECTOR_CID =
  Components.ID("{31839213-23f5-41f7-8380-090b3e28b503}");

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                   "@mozilla.org/parentprocessmessagemanager;1",
                   "nsIMessageBroadcaster");

// Factory constructor
function SEConnectorFactory() {}

/**
 * Factory like pattern for getting the Connector obj.
 */
SEConnectorFactory.prototype = {

  getConnector: function(type) {
    switch (type) {
      case SE.TYPE_UICC:
        return UiccConnector;
      case SE.TYPE_ESE:
      default:
        if (DEBUG) debug('UnSupported SEConnector : ' + type);
        return null;
    }
  }
};

/**
 * 'gMap' is a nested dictionary object that mananges all the necessary information
 * pertainining to multiple sessions and channels for a given application (appId).
 * An application (appId / content) can open multiple sessions.
 * In turn each session can open multiple channels with the secure element.
 * Following are its (key,value) attributes and brief description :
 * (key)'appId'       : Key used mainly to retrieve the 'session obj' (sessions).
 * 'target'           : Target obj that identifies the content target to notify to
 * 'readerTypes'      : Types ('uicc' / 'eSE') that are available to the
                        application (appId)
 * 'sessions'         : Dictionary obj that holds all the sessions opened
                        by the application (appId)
 * (key)'sessionToken': Key used to retrieve the 'session info ' such as
                        'type' & 'channels'
 * 'type'             : Session type indicating 'uicc' (or) 'eSE'
 * 'channels'         : Dictionary obj that holds all the channels opened by the session.
 * (key)'token'       : Key used to retrieve 'channel info' such as 'aid' ,
                        'channel Number' and the 'type' of channel
 * 'type'             : Channel type indicating if it is 'logical' / 'basic'
 * 'aid'              : AID that identifies the opened channel.
 * 'channel'          : The channel number that was returned by lower layers upon
                        successfully opening a channel
 */
XPCOMUtils.defineLazyGetter(this, "gMap", function() {
  return {
    /*
    ------------------------------
       Structure of 'appInfoMap':
    ------------------------------
    {[appId :// (key = '1020')
        target         : msg.target
        readerTypes    : [] // 'uicc','eSE'
        sessions       : {
           [sessionToken : // (key = '1111')
              type :
              channels : {
                 [token: // (key = 'aaaaa')
                    type:
                    aid :
                     channel : ]
                 [token: // (key = 'bbbbb')
                    type:
                    aid :
                     channel : ]
                 [token: // (key = 'ccccc')
                    type:
                    aid :
                     channel :]
              }] // End of 'channels'
           [sessionToken : // (key = '22222')
              type :
              channels : {
                 [token: // (key = 'ddddd')
                    type:
                    aid :
                     channel :]
                 [token: // (key = 'eeeee')
                    type:
                    aid :
                     channel : ]
                 [token: // (key = 'fffff')
                    type:
                    aid :
                     channel :]
              }] // End of 'channels'
        }] // End of 'sessions'
     [appId : // (key = '1025')
         ...
         ...
         ...
     ]} */
    appInfoMap: {},

    uuidGenerator: null,

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
    unregisterSecureElementTarget: function(target) {
      let targets = this.appInfoMap;
      let appIdKeys = Object.keys(targets);

      for (let i = 0; i < appIdKeys.length; i++) {
        let appId = appIdKeys[i];
        let targetInfo = targets[appId];
        if (targetInfo && targetInfo.target === target) {
          // Remove the target from the list of registered targets
          if (DEBUG) debug("Unregisterd SE Target for AppId : " + appId);
          delete targets[appId];
        }
      }
    },

    // Get the 'appInfo (appId & readerTypes)' associated with this 'target'.
    getAppInfoByMsgTarget: function(target) {
      let targets = this.appInfoMap;
      let appIdKeys = Object.keys(targets);

      for (let i = 0; i < appIdKeys.length; i++) {
        let appId = appIdKeys[i];
        let targetInfo = targets[appId];
        if (targetInfo && targetInfo.target === target) {
          return { appId: appId, readerTypes: targetInfo.readerTypes };
        }
      }
    },

    // Gets all the channels in an array for the given appId and
    // optional reader type
    getAllChannelsByAppIdType: function(appId, type) {
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channels : " + appId + ", type:" + type);
        return [];
      }

      let allChannels = [];
      let sessions = appInfo.sessions;
      Object.keys(sessions).forEach((sKey) => {
        if (type && sessions[sKey].type !== type) {
          return;
        }

        let channels = this._getChannels(sessions[sKey].channels);
        allChannels = allChannels.concat(channels);
      });

      return allChannels;
    },

    // Checks if the 'readerType' is a registered / supported one or not for
    // the given 'appId'
    isSupportedReaderType: function(data) {
      // TODO: Bug 1118101 - Get supported readerTypes based on the permissions
      //                      available for the given.
      let types = this.appInfoMap[data.appId].readerTypes;
      return (types.indexOf(data.type) > -1);
    },

    /**
     * Session related functions
     */

    // Add a new sessionToken for a given appId
    addSession: function(msg) {
      let appId = msg.appId;
      let type = msg.type;
      // Generate a unique sessionToken and send it to content. All the subsequent
      // operations may happen on this session.
      let sessionToken = this._getUUIDGenerator().generateUUID().toString();

      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to add session: " + appId);
        return null;
      }
      appInfo.sessions[sessionToken] = { type: type,
                                      channels: {} };
      return sessionToken;
    },

    // Remove the sessionToken from given appId
    removeSession: function(msg) {
      let sessions = this.appInfoMap[msg.appId].sessions;
      if (sessions[msg.sessionToken].type === msg.type)
        delete sessions[msg.sessionToken];
    },

    // Removes / Resets all sessions for a given appId.
    removeAllSessions: function(msg) {
      let allSessions = this.appInfoMap[msg.appId].sessions;
      // reset all sessions
      if (allSessions)
        allSessions = {};
    },

    // Returns true if the given sessionToken is already registered / valid one,
    // else returns false
    isValidSession: function(data) {
      let { appId: appId, sessionToken: sToken, channelToken: chToken } = data;

      // appId needs to be present
      if (!appId || !this.appInfoMap[appId]) {
        return false;
      }

      if (sToken && !this.appInfoMap[appId].sessions[sToken]) {
        return false;
      }

      return true;
    },

    // Gets channel count associated with the 'sessionToken'
    getChannelCountBySessionToken: function(sessionToken, appId) {
      let session = this.appInfoMap[appId].sessions[sessionToken];
      if (!session) {
        debug("Unable to get channel count : " + appId + " sessionToken: " + sessionToken);
        return 0;
      }
      return Object.keys(session.channels).length;
    },

    // Gets all the channels associated with the 'sessionToken'
    getAllChannelsBySessionToken: function(sessionToken, appId) {
      let session = this.appInfoMap[appId].sessions[sessionToken];
      return this._getChannels(session.channels);
    },

    /**
     * channel related functions
     */

    // Add new channel to a given sessionToken. Upon successfully adding the entry
    // this function will return the 'token'
    addChannel: function(channel, msg) {
      let appId = msg.appId;
      // Generate a unique 'token' (alias) instead of sending the actual 'channel number'.
      // to the content. Any further 'Channel' related operations by the content
      // shall operate using this token.
      let token = this._getUUIDGenerator().generateUUID().toString();

      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to add channel: " + appId);
        return null;
      }
      let session = appInfo.sessions[msg.sessionToken];
      if (!session) {
        debug("Unable to add channel: Inavlid session, " + msg.sessionToken +
              " appId:" + appId);
        return null;
      }

      // Add if 'type' matches
      if (session.type !== msg.type) {
        if (DEBUG) debug("Unable to add channel: Type Mismatch - " + session.type +
                         " Vs " + msg.type + " (or) Channel already added:" +
                          channel + " " + session.channels[token].channel);
        return null;
      }
      // Add the entry
      session.channels[token] = { aid: msg.aid,
                                  channel:  channel };
      return token;
    },

    // Remove the given ''channel' entry based on type.
    // Note that ''channel' will be unique per type
    removeChannel: function(channel, type) {
      let targets = this.appInfoMap;
      Object.keys(targets).forEach((appId) => {
        let sessions = targets[appId].sessions;
        Object.keys(sessions).forEach((sessionToken) => {
          if (sessions[sessionToken].type === type) {
            let channels = sessions[sessionToken].channels;
            Object.keys(channels).forEach((token) => {
              if (channels[token].channel ===  channel) {
                // We have found the match
                if (DEBUG) debug("Deleting channel with token : " + token +
                                 ",  channel : " +  channel);
                delete channels[token];
              }
            }); // End of Channels keys
          }
        }); // End of Sessions keys
      }); // End of AppId keys
    },

    // Validates the given 'channelToken' by checking if it is a registered one
    // for the given (appId, sessionToken, channelToken)
    isValidChannelToken: function(data) {
      let { appId: appId, sessionToken: sToken, channelToken: chToken } = data;

      // appId needs to be present
      if (!appId || !this.appInfoMap[appId]) {
        return false;
      }

     if (sToken && !this.appInfoMap[appId].sessions[sToken]) {
        return false;
      }

      if (chToken && !this.appInfoMap[appId].sessions[sToken].channels[chToken]) {
        return false;
      }

      return true;
    },

    // Get the 'channel' associated for a given (appId, sessionToken, channelToken)
    getChannel: function(data) {
      if (!this.isValidChannelToken(data)) {
        if (DEBUG) debug("InValid Channel Token. Unable to get the channel");
        return null;
      }

      return this.appInfoMap[data.appId].sessions[data.sessionToken].
        channels[data.channelToken].channel;
    },

    /*
     * Private internal functions
     */

    // Retrieves all the channels for the given 'channels' object.
    // For example, consider that there are 3 channels opened in a given session.
    // Say, appInfoMap's 'channels' obj is as follows:
    // channels : {
    //   [token: // (key = 'aaaaa')
    //     type:
    //     aid :
    //     channel : 2]
    //   [token: // (key = 'bbbbb')
    //     type:
    //     aid :
    //     channel : 3]
    //   [token: // (key = 'ccccc')
    //     type:
    //     aid :
    //     channel : 4]
    // }] // End of 'channels'
    // This function returns an array of channels [2,3,4]. If no 'channel entry'
    // exists in 'channels it returns an emppty array '[]'
    _getChannels: function(channels) {
      channels = channels || {};
      return Object.keys(channels).map(cKey => channels[cKey].channel);
    },

    _getUUIDGenerator: function() {
      // This check ensures that by calling this internal helper does not create a new
      // instance of 'nsIUUIDGenerator' everytime.
      if (!this.uuidGenerator) {
        this.uuidGenerator =
          Cc["@mozilla.org/uuid-generator;1"].createInstance(Ci.nsIUUIDGenerator);
      }
      return this.uuidGenerator;
    },

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
        Object.keys(sessions).forEach((sessionToken) => {
          debug("       sessionToken key : " + sessionToken);
          debug("                      type : " + sessions[sessionToken].type);
          let channels = sessions[sessionToken].channels;
          Object.keys(channels).forEach((token) => {
            debug("                          token key : " + token);
            debug("                                    Type : " + channels[token].type);
            debug("                                     channel : " + channels[token].channel);
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
 * 'IccListenerCtx' instance  implements 'nsIIccListener' to monitor the state of
 * 'uicc' card for given clientId. It exposes two public functions to init()
 * and shutdown() to monitor the uicc card state changes.
 */
function IccListenerCtx(clientId, iccProvider) {
  this._clientId = clientId;
  this._iccProvider = iccProvider;
}
IccListenerCtx.prototype = {
  _clientId: 0xFF,

  _iccProvider: null,

  _isPresent: false,

  QueryInterface: XPCOMUtils.generateQI([Ci.nsIIccListener]),

  /**
   * nsIIccListener interface methods.
   */
  notifyStkCommand: function() {},

  notifyStkSessionEnd: function() {},

  notifyIccInfoChanged: function() {},

  notifyCardStateChanged: function() {
    this._updatePresenceState();
  },

  init: function() {
    this._iccProvider.registerIccMsg(this._clientId, this);

     // Update the state in order to avoid race condition.
     // By this time, 'notifyCardStateChanged (with proper card state)'
     // may have occurred already before this instance initialization.
     this._updatePresenceState();
  },

  shutdown: function() {
    this._iccProvider.unregisterIccMsg(this._clientId, this);
  },

  isPresent: function() {
    return this._isPresent;
  },

  _updatePresenceState: function() {
    // Consider following Card states as not quite ready for performing IccChannel* related commands
    let notReadyStates = [
      "unknown",
      "illegal",
      "personalizationInProgress",
      "permanentBlocked",
    ];
    let cardState = this._iccProvider.getCardState(this._clientId);
    this._isPresent = (((cardState !== null) && (notReadyStates.indexOf(cardState) == -1)) ? true : false);
  }
};

/**
 * 'UiccConnector' object is a wrapper over iccProvider's channel management
 * related interfaces. It holds 'IccListenerCtx' instances per clientId.
 *
 * This object exposes the following public methods:
 * start()
 * stop()
 * isSEPresent(clientId)
 * doOpenChannel(clientId, aid, callback)
 * doTransmit(clientId, command, callback)
 * doCloseChannel(clientId, channel, callback)
 * doCloseAll(clientId, [channels], callback)
 */
XPCOMUtils.defineLazyGetter(this, "UiccConnector", function() {
  return {
    _iccProvider: null,

    _iccListenerCtx: [],

    _numClients: 0,

    // Initializes iccListener context per clientId to monitor UICC state
    start: function() {
      this._numClients = Cc["@mozilla.org/ril;1"].
                         getService(Ci.nsIRadioInterfaceLayer).numRadioInterfaces;
      for (let clientId = 0; clientId < this._numClients; clientId++) {
        let iccListenerCtx = new IccListenerCtx(clientId, this._getProvider());
        this._iccListenerCtx.push(iccListenerCtx);
        iccListenerCtx.init();
      }
    },

    // Detaches the listener and stops monitoring UICC state changes.
    stop: function() {
      for (let clientId = 0; clientId < this._numClients; clientId++) {
        this._iccListenerCtx[clientId].shutdown();
      }
      this._iccListenerCtx = [];
    },

    // Checks to see if the SE is present or not for a given clientId.
    isSEPresent: function(clientId) {
      let iccListenerCtx = this._iccListenerCtx[clientId];
      if (!iccListenerCtx) {
        return false;
      }
      return iccListenerCtx.isPresent();
    },

    /**
     * Opens a supplemetary channel on a given clientId
     *
     * @param clientId
     *        ClientId representing a UICC / SIM slot
     * @param aid
     *        Application Identifier identifying the applet on the card.
     * @param callback
     *        Callback interface that implements 'nsISEChannelCallback'.
     *        The result will be notified either through
     *        'notifyOpenChannelSuccess(channel, openResponse)' (or)
     *        'notifyError(error)'.
     */
    doOpenChannel: function(clientId, aid, callback) {
      this._checkPresence(clientId);

      let aidLen = aid ? aid.length : 0;
      if (aidLen === 0) {
        // According to SIMalliance_OpenMobileAPI v3 draft,
        // it is recommended not to support it.
        debug("AID is not set. Reject the openChannel request!");
        throw new Error(SE.ERROR_SECURITY);
      }
      // Note that 'aid' is a string, and therefore max length = SE.MAX_AID_LEN * 2
      if (aidLen < SE.MIN_AID_LEN || aidLen > SE.MAX_AID_LEN * 2) {
        debug("Invalid AID length : " + aidLen);
        throw new Error(SE.ERROR_GENERIC);
      }

      // TODO: Bug 1118106 : Handle Resource management / leaks by persisting
      //                     the newly opened channel in some persistent
      //                     storage so that when this module gets restarted
      //                     (say after opening a channel) in the event of
      //                     some erroneous conditions such as gecko restart /,
      //                     crash it can read the persistent storage to check
      //                     if there are any held resources. (opened channels)
      //                     and close them.
      let self = this;
      this._getProvider().iccOpenChannel(clientId, aid, {
        notifyOpenChannelSuccess: function(channel) {
          self._doGetOpenResponse(clientId, channel, 0x00, function(result) {
            if (callback) {
              callback.notifyOpenChannelSuccess(channel, result.response);
            }
          });
        },

        notifyError: function(reason) {
          debug('Failed to open the channel to AID : ' + aid +
                ', Rejected with Reason : ' + reason);
          if (callback) {
            callback.notifyError(reason);
          }
        }
      });
    },

    /**
     * Transmit the C-APDU (command) on given clientId.
     *
     * @param clientId
     *        ClientId representing a UICC / SIM slot
     * @param command
     *        Command APDU ('cla', 'ins', 'p1', 'p2', 'data', 'le').
     * @param callback
     *        Callback interface that implements 'nsISEChannelCallback'.
     *        The result will be notified either through,
     *        'notifyExchangeAPDUResponse(sw1, sw2, response)' (or)
     *        'notifyError(error)'.
     */
    doTransmit: function(clientId, command, callback) {
      this._checkPresence(clientId);

      let cla = command.cla;
      let ins = command.ins;
      let p1 = command.p1;
      let p2 = command.p2;
      let data = null;
      let appendLe = (command.data !== null) && (command.le !== -1);
      // Note that P3 of the C-TPDU is set to ‘00’ in Case 1 (only headers) scenarios
      let p3 = 0x00;
      // Determine p3
      if (command.data !== null && command.le !== -1) {
        // In case both data and le are set, (case 4) then 'p3 = data length'
        p3 = command.data.length;
      } else if (command.data !== null ) {
        // Only data is set, 'p3=lc / data length'
        p3 = command.data.length; // lc
      } else if (command.le !== -1) {
        // Only le is set. 'p3=le'. Response expected!
        p3 = command.le;
      }

      // At this point perform more sanity checks on the c-apdu
      if (p3 + SE.APDU_HEADER_LEN > SE.MAX_APDU_LEN) {
        debug("Data length exceeds max limit - " + SE.MAX_APDU_LEN +
              " Extended APDU is not supported! : " + command.length);
        throw new Error(SE.ERROR_GENERIC);
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
        data = SEUtils.byteArrayToHexString(commandData);
      }
      if (data && appendLe) {
        // Append 'le' value to data
        let leHexStr = SEUtils.byteArrayToHexString([
          command.le & 0xFF, (command.le >> 8) & 0xFF
        ]);
        data += leHexStr;
      }
      let channel = this._getChannelNumber(cla);
      if (DEBUG) debug("transmit on Channel # " + channel);

      // Pass empty response '' as args as we are not interested in appended
      // responses yet!
      this._doIccExchangeAPDU(clientId, channel, cla, ins,
                              p1, p2, p3, data, '', callback);
    },

    /**
     * Closes the channel on given clientId.
     *
     * @param clientId
     *        ClientId representing a UICC / SIM slot
     * @param channel
     *        Channel number to be closed
     * @param callback
     *        Callback interface that implements 'nsISEChannelCallback'.
     *        The result will be notified either through
     *        'notifyCloseChannelSuccess()' (or) 'notifyError(error)'.
     */
    doCloseChannel: function(clientId, channel, callback) {
      this._checkPresence(clientId);

      this._getProvider().iccCloseChannel(clientId, channel, {
        notifyCloseChannelSuccess: function() {
          if (DEBUG) debug("doCloseChannel successfully closed the channel # : " + channel);
          if (callback) {
            callback.notifyCloseChannelSuccess();
          }
        },

        notifyError: function(reason) {
          debug('Failed to close the channel #  : ' + channel +
                ', Rejected with Reason : ' + reason);
          if (callback) {
            callback.notifyError(reason);
          }
        }
      });
    },

    // Closes all the channels on given clientId.
    doCloseAll: function(clientId, channels, callback) {
      this._checkPresence(clientId);

      let closedChannels = [];
      if (!channels || channels.length === 0) {
        if (callback) {
          callback({ error: SE.ERROR_GENERIC, channels: closedChannels,
                     reason: "No Active Channels to be closed!"});
        }
        return;
      }

      let count = 0;
      for (let index = 0; index < channels.length; index++) {
        let channel = channels[index];
        if (channel === SE.BASIC_CHANNEL) {
          if (DEBUG) debug("Basic Channel can never be closed!");
          if (callback && (++count === channels.length)) {
            callback({ error: SE.ERROR_GENERIC,
                       reason: "Basic Channel can never be closed!"});
          }
        }

        if (!channel) continue;
        if (DEBUG) debug("Attempting to Close Channel # : " + channel);

        this._getProvider().iccCloseChannel(clientId, channel, {
          notifyCloseChannelSuccess: function() {
            if (DEBUG) debug("notifyCloseChannelSuccess # : " + channel);
            closedChannels.push(channel);
            if (callback && (++count === channels.length)) {
              callback({ error: SE.ERROR_NONE, channels: closedChannels });
            }
          },

          notifyError: function(reason) {
            debug('Failed to close the channel #  : ' + channel +
                  ', Rejected with Reason : ' + reason);
            if (callback && (++count === channels.length)) {
              callback({ error: SE.ERROR_BADSTATE, channels: closedChannels,
                         reason: reason });
            }
          }
        });
      }
    },

    setChannelToClassByte(cla,  channel) {
      if (channel < 4) {
        // b7 = 0 indicates the first interindustry class byte coding
        cla = (((cla & 0x9C) & 0xFF) |  channel);
      } else if (channel < 20) {
        // b7 = 1 indicates the further interindustry class byte coding
        cla = (((cla & 0xB0) & 0xFF) | 0x40 | (channel - 4));
      } else {
        debug("Channel number must be within [0..19]");
        return SE.ERROR_GENERIC;
      }
      return cla;
    },

    // Following are the private functions

    _doGetOpenResponse: function(clientId, channel, length, callback) {
      let openResponseCommand = {
        cla: channel & 0xFF,
        ins: SE.INS_GET_RESPONSE,
        p1: 0x00,
        p2: 0x00,
        p3: length, //Indicate to UICC card to get all the available response bytes.
        data: null
      };

      this.doTransmit(clientId, openResponseCommand, {
        notifyExchangeAPDUResponse: function(sw1, sw2, response) {
          if (DEBUG) debug('GET Response : ' + response);
	  if (callback) {
            callback({ error: SE.ERROR_NONE, sw1: sw1, sw2: sw2,
              response: response });
          }
        },

        notifyError: function(reason) {
          debug('Failed to open the channel to AID : ' + aidStr +
                ', Rejected with Reason : ' + reason);
          if (callback) {
            callback({ error: SE.ERROR_INVALIDAPPLICATION, reason: reason });
          }
        }
      });
    },

    _doIccExchangeAPDU: function(clientId, channel, cla, ins, p1, p2,
                                 p3, data, appendResponse, callback) {
      let response = '';
      let self = this;

      this._getProvider().iccExchangeAPDU(clientId, channel,
                                  (cla & 0xFC), ins, p1, p2, p3, data, {
        notifyExchangeAPDUResponse: function(sw1, sw2, response) {

          if (DEBUG) debug("sw1 : " + sw1 + ", sw2 : " + sw2 +
                           ", response : " + response);

          // Copy the response
          response = (response && response.length > 0) ?
                      response + appendResponse : appendResponse;

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
            callback.notifyExchangeAPDUResponse(sw1, sw2, response);
          }
        },

        notifyError: function(reason) {
          debug('Failed to trasmit C-APDU over the channel #  : ' + channel +
                ', Rejected with Reason : ' + reason);
          if (callback) {
            callback.notifyError(reason);
          }
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

    _checkPresence: function _checkPresence(clientId) {
      if (clientId >= this._numClients) {
        throw new Error(SE.ERROR_GENERIC + ",Invalid ClientId " + clientId);
      }

      if (!this.isSEPresent(clientId)) {
        throw new Error(SE.ERROR_BADSTATE + ",UICC Secure Element is not present!");
      }
    },

    _getProvider: function() {
      // This check ensures that by calling this internal helper does not create a new
      // instance of 'nsIIccProvider' for everytime.
      if (!this._iccProvider) {
        this._iccProvider =
          Cc["@mozilla.org/ril/content-helper;1"].createInstance(Ci.nsIIccProvider);
      }
      return this._iccProvider;
    }
  };
});

/**
 * 'SecureElementManager' is the main object that interfaces with
 * child process / content. It is also the 'message manager' of the module.
 * It interacts with other objects such as 'gMap' & 'Connector instances
 * (UiccConnector, eSEConnector)' to perform various operations.
 * It mainly interacts with 'gMap' to query the state of Readers, Sessions, Channels,
 * while it interacts with 'Connector instances' to perform low level SE-related
 * (open,close,transmit) I/O operations.
 */
function SecureElementManager() {
  this._registerMessageListeners();
  this.connectorFactory = new SEConnectorFactory();
  // This is needed for UiccConnector to start listening on uicc state changes
  this.connectorFactory.getConnector(SE.TYPE_UICC).start();

  // Initialize handlers array
  this.handlers["SE:OpenChannel"] = this.openChannel;
  this.handlers["SE:CloseChannel"] = this.closeChannel;
  this.handlers["SE:TransmitAPDU"] = this.transmit;
  this.handlers["SE:CloseAllByReader"] = this.closeAllChannelsByReader;
  this.handlers["SE:CloseAllBySession"] = this.closeAllChannelsBySessionToken;

  Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
}

SecureElementManager.prototype = {
  classID: SECUREELEMENTMANAGER_CID,
  classInfo: XPCOMUtils.generateCI({
    classID: SECUREELEMENTMANAGER_CID,
    contractID: SECUREELEMENTMANAGER_CONTRACTID,
    classDescription: "SecureElementManager",
    interfaces: [Ci.nsIMessageListener,
                 Ci.nsIObserver]
  }),

  connectorFactory: null,

  handlers: [],

  _shutdown: function() {
    this.secureelement = null;
    this.connectorFactory.getConnector(SE.TYPE_UICC).stop();
    this.connectorFactory = null;
    Services.obs.removeObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID);
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
      debug("OpenChannel: Invalid Session! " + msg.sessionToken +
	    " for appId : " + msg.appId);
      return SE.ERROR_GENERIC;
    }

    if (gMap.getChannelCountBySessionToken(msg.sessionToken, msg.appId) >=
	  SE.MAX_CHANNELS_ALLOWED_PER_SESSION) {
      debug("Max channels per session exceed !!!");
      return SE.ERROR_GENERIC;
    }

    return error;
  },

  _checkErrorsForTransmit(msg) {
    let error = SE.ERROR_NONE;
    if (!gMap.isValidSession(msg)) {
      debug("Transmit: Invalid Session! " + msg.sessionToken +
	    " for appId : " + msg.appId);
      return SE.ERROR_GENERIC;
    }

    if (!gMap.isValidChannelToken(msg)) {
      debug("Invalid Token - " + msg.channelToken + ", [appId: " + msg.appId +
	      ", sessionToken: " + msg.sessionToken + " ]");
      return SE.ERROR_GENERIC;
    }
    return error;
  },

  _checkErrorsForCloseChannel(msg) {
    let error = SE.ERROR_NONE;
    if (!gMap.isValidSession(msg)) {
      debug("CloseChannel: Invalid Session " + msg.sessionToken +
	    " for appId : " + msg.appId);
      return SE.ERROR_GENERIC;
    }

    if (!gMap.isValidChannelToken(msg)) {
      debug("Invalid Token - " + msg.channelToken + ", [appId: " + msg.appId +
	      ", sessionToken: " + msg.sessionToken + " ]");
      return SE.ERROR_GENERIC;
    }
    return error;
  },

  // Private function used to retreive available readerNames
  _getAvailableReaders: function() {
    let readerTypes = [];
    // TODO 1: Bug 1118096 - Add IDL so that other sub-systems such as RIL ,
    //                       NFC can implement it.
    // TODO 2: Bug 1118097 - According to OpenMobile spec, the reader names
    //                       should support slot based naming convention.
    //                       i;e; Instead of returning 'uicc', return 'uicc<slot#>'.
    readerTypes.push(SE.TYPE_UICC);
    return readerTypes;
  },

  _closeAll: function(type, channels, callback) {
    let connector = this.connectorFactory.getConnector(type);
    try {
      connector.doCloseAll(PREFERRED_UICC_CLIENTID, channels, function(result) {
        // Remove all the channel entries from the map, since these channels have
        // been successfully closed
        for (let i = 0; i < result.channels.length; i++) {
	  gMap.removeChannel(result.channels[i], type);
        }
        // Do not expose removed channels to content
        delete result.channels;
        if (callback) {
          callback(result);
        }
      });
    } catch (error) {
      if (DEBUG) {
	debug("Exception thrown while 'doClose' "+ error);
	if (callback) {
          callback({ error: error });
        }
      }
    }
  },

  _closeAllChannelsByAppId: function(data, callback) {
    return this._closeAll(data.type,
      gMap.getAllChannelsByAppIdType(data.appId), callback);
  },

  // Following functions are handlers for requests from content

  openChannel: function(msg, callback) {
    // Perform Sanity Checks!
    let error = this._checkErrorsForOpenChannel(msg);
    if (error !== SE.ERROR_NONE) {
      if (callback) {
        callback({ error: error });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module

    // Sanity passed! Create Connector obj based on the 'type'
    let connector = this.connectorFactory.getConnector(msg.type);
    try {
      connector.doOpenChannel(PREFERRED_UICC_CLIENTID,
        SEUtils.byteArrayToHexString(msg.aid), {
        notifyOpenChannelSuccess: function(channel, openResponse) {
	  // Add the new 'channel' to the map upon success
	  let channelToken = gMap.addChannel(channel, msg);
          if (callback) {
            callback({ error: SE.ERROR_NONE, channelToken: channelToken,
                       isBasicChannel: (channel === SE.BASIC_CHANNEL),
                       openResponse: SEUtils.hexStringToByteArray(openResponse) });
          }
        },

        notifyError: function(reason) {
          debug('Failed to open the channel to AID : ' +
                 SEUtils.byteArrayToHexString(msg.aid) +
                 ', Rejected with Reason : ' + reason);
          if (callback) {
            callback({ error: SE.ERROR_IO, reason: reason, response: [] });
          }
        }
      });

    } catch (error) {
      if (DEBUG) {
	debug("Exception thrown while 'doOpenChannel' "+ error);
	if (callback) {
          callback({ error: error });
        }
      }
    }
  },

  transmit: function(msg, callback) {
    // Perform basic sanity checks!
    let error = this._checkErrorsForTransmit(msg);
    if (error !== SE.ERROR_NONE) {
      if (callback) {
        callback({ error: error });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module

    let connector = this.connectorFactory.getConnector(msg.type);
    // Set the channel to CLA before calling connector's doTransmit.
    // See GP Spec, 11.1.4 Class Byte Coding
    let channel = gMap.getChannel(msg);
    // Use connector to set the class byte
    msg.apdu.cla = connector.setChannelToClassByte(msg.apdu.cla, channel);
    try {
      connector.doTransmit(PREFERRED_UICC_CLIENTID, msg.apdu, {
        notifyExchangeAPDUResponse: function(sw1, sw2, response) {
	  if (callback) {
            callback({ error: SE.ERROR_NONE, sw1: sw1, sw2: sw2,
              response: SEUtils.hexStringToByteArray(response) });
          }
        },

        notifyError: function(reason) {
          debug('Failed to open the channel to AID : ' + aidStr +
                ', Rejected with Reason : ' + reason);
          if (callback) {
            callback({ error: SE.ERROR_INVALIDAPPLICATION, reason: reason });
          }
        }
      });
    } catch (error) {
      if (DEBUG) {
	debug("Exception thrown while 'doTransmit' "+ error);
	if (callback) {
          callback({ error: error });
        }
      }
    }
  },

  closeChannel: function(msg, callback) {
    // Perform Sanity Checks!
    let error = this._checkErrorsForCloseChannel(msg);
    if (error !== SE.ERROR_NONE) {
      if (callback) {
        callback({ error: error });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module

    // Sanity passed! Create Connector obj based on the 'type'
    let connector = this.connectorFactory.getConnector(msg.type);
    let channel = gMap.getChannel(msg);
    connector.doCloseChannel(PREFERRED_UICC_CLIENTID, channel, {
      notifyCloseChannelSuccess: function() {
        gMap.removeChannel(channel, msg.type);
        if (callback) {
          callback({ error: SE.ERROR_NONE });
        }
      },

      notifyError: function(reason) {
        debug('Failed to close the channel #  : ' + channel +
              ', Rejected with Reason : ' + reason);
        if (callback) {
          callback({ error: SE.ERROR_BADSTATE, reason: reason });
        }
      }
    });
  },

  // Closes all the channels opened by a session
  closeAllChannelsBySessionToken: function(data, callback) {
    return this._closeAll(data.type,
      gMap.getAllChannelsBySessionToken(data.sessionToken, data.appId), callback);
  },

  // Closes all the channels opened by the reader
  closeAllChannelsByReader: function(data, callback) {
    return this._closeAll(data.type,
      gMap.getAllChannelsByAppIdType(data.appId, data.type), callback);
  },

  // 1. Query the map to get 'appInfo' based on 'msg.target'.
  //    (appInfo.appId & appInfo.readerTypes)
  // 2. Iterate over all registered readerTypes and close all channels by type.
  // 3. Finally unregister the target from 'gMap' by deleting its entry.
  handleChildProcessShutdown: function(target) {
    let appInfo = gMap.getAppInfoByMsgTarget(target);
    if (!appInfo) return;
    for (let i = 0; i < appInfo.readerTypes.length; i++) {
      // No need to pass the callback
      this._closeAllChannelsByAppId({appId: appInfo.appId,
				    type: appInfo.readerTypes[i]}, null);
    }
    gMap.unregisterSecureElementTarget(target);
  },

  handleGetSEReadersRequest: function(msg) {
    let promiseStatus = "Rejected";
    let seReaderTypes = this._getAvailableReaders();
    let options = {
      metadata: msg.json
    };
    if (seReaderTypes.length > 0) {
      gMap.registerSecureElementTarget(msg, seReaderTypes);
      // Add the result
      options['result'] = {readerTypes: seReaderTypes};
      promiseStatus = "Resolved";
    }
    msg.target.sendAsyncMessage(msg.name + promiseStatus, options);
  },

  handleOpenSessionRequest: function(msg) {
    let promiseStatus = "Rejected";
    let options = {
      metadata: msg.json
    };
    // Perform two checks before allowing opening of session
    // 1. Check if the type is already a supported one
    //          AND
    // 2. Check if the 'session type' that content is attempting to connect to is
    //    in a 'present state' by queriying the appropriate 'connector obj'.
    if (gMap.isSupportedReaderType(msg.json) &&
      this.connectorFactory.getConnector(msg.json.type).isSEPresent(PREFERRED_UICC_CLIENTID)) {
      promiseStatus = "Resolved";
      // Add the result
      options['result'] = {sessionToken: gMap.addSession(msg.json)};
    }
    msg.target.sendAsyncMessage(msg.name + promiseStatus, options);
  },

  handleRequest: function(msg) {
    let handler = this.handlers[msg.name].bind(this);
    handler(msg.json, function(result) {
      let promiseStatus = (result.error === SE.ERROR_NONE) ? "Resolved" : "Rejected";
      let options = {
	result: result,
	metadata: msg.json
      };
      msg.target.sendAsyncMessage(msg.name + promiseStatus, options);
    });
  },

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
    if (DEBUG) debug("Received '" + msg.name + "' message from content process" + ": " +
		     JSON.stringify(msg.data));
    if (msg.name == "child-process-shutdown") {
      // By the time we receive child-process-shutdown, the child process has
      // already forgotten its permissions so we need to unregister the target
      // for every permission.
      this.handleChildProcessShutdown(msg.target);
      return null;
    }

    if (SE_IPC_SECUREELEMENT_MSG_NAMES.indexOf(msg.name) != -1) {
      if (!msg.target.assertPermission("secureelement-manage")) {
	debug("SecureElement message " + msg.name +
	      " from a content process with no 'secureelement-manage' privileges.");
	throw new Error("Don't know about this message: " + msg.name);
      }
    } else {
      debug("Ignoring unknown message type: " + msg.name);
      return null;
    }

    switch (msg.name) {
      case "SE:GetSEReaders":
	this.handleGetSEReadersRequest(msg);
	break;
      case "SE:OpenSession":
	this.handleOpenSessionRequest(msg);
	break;
      case "SE:OpenChannel":
      case "SE:CloseChannel":
      case "SE:TransmitAPDU":
      case "SE:CloseAllBySession":
      case "SE:CloseAllByReader":
	this.handleRequest(msg);
	break;
      case "SE:IsSEPresent":
        return this.connectorFactory.getConnector(msg.json.type).
          isSEPresent(PREFERRED_UICC_CLIENTID);
    }
    return null;
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

/**
 * SecureElementConnector instance  implements 'nsISecureElementConnector'.
 * This is primarly used by external modules such as 'Access Control Enforcer (ACE)'
 * to perform primitive channel related operations such as
 * Opening a supplementary channel,
 * Exchanging Command APDU, and
 * Closing the channel.
 * Note: Instance of this object is only accessible to parent process modules
         for security reasons.
 */
function SecureElementConnector() {
  let appInfo = Cc["@mozilla.org/xre/app-info;1"];
  // Flag to determine this process is a parent or child process.
  this._isParentProcess =
    !appInfo || appInfo.getService(Ci.nsIXULRuntime)
                  .processType == Ci.nsIXULRuntime.PROCESS_TYPE_DEFAULT;
  if (DEBUG) {
    debug("Is user of nsISecureElementConnector interface, " +
      "a parent process module ? " + this._isParentProcess);
  }
  this._connectorFactory = new SEConnectorFactory();
}
SecureElementConnector.prototype = {
  _connectorFactory: null,

  _isParentProcess: false,

  classID:   SECUREELEMENTCONNECTOR_CID,
  classInfo: XPCOMUtils.generateCI({
    classID: SECUREELEMENTCONNECTOR_CID,
    contractID: SECUREELEMENTCONNECTOR_CONTRACTID,
    classDescription: "SecureElement Connector",
    interfaces: [Ci.nsISecureElementConnector]}),

  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsISecureElementConnector]),

  seOpenChannel: function(type, clientId, aid, callback) {
    this._ensureParentProcess();

    let connector = this._connectorFactory.getConnector(this._getType(type));
    connector.doOpenChannel(clientId, aid, callback);
  },

  seExchangeAPDU: function(type, clientId, channel, cla, ins, p1, p2, data, le, callback) {
    this._ensureParentProcess();

    let connector = this._connectorFactory.getConnector(this._getType(type));
    // Mask the class byte with channel
    let classByte = connector.setChannelToClassByte(cla, channel);
    let cmdData = data ? SEUtils.hexStringToByteArray(data) : null;
    let commandAPDU = {
      cla: classByte,
      ins: ins,
      p1: p1,
      p2: p2,
      data: cmdData,
      le: le
    };
    connector.doTransmit(clientId, commandAPDU, callback);
  },

  seCloseChannel: function(type, clientId, channel, callback) {
    this._ensureParentProcess();

    let connector = this._connectorFactory.getConnector(this._getType(type));
    connector.doCloseChannel(clientId, channel, callback);
  },

  _getType: function(type) {
    switch (type) {
      case Ci.nsISecureElementConnector.SE_TYPE_UICC:
        return SE.TYPE_UICC;
      case Ci.nsISecureElementConnector.SE_TYPE_ESE:
        return SE.TYPE_ESE;
      default:
        return null;
    }
  },

  _ensureParentProcess: function() {
    if (!this._isParentProcess) {
      throw new Error(SE.ERROR_SECURITY +
        ",Only Parent process module can access the interfaces' :" +
        "'nsISecureElementConnector' APIs");
    }
  }
};
this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElementManager, SecureElementConnector]);

