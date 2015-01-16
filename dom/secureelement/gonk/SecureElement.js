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

/* globals dump, Components, XPCOMUtils, SE, Services, UiccConnector,
   SEUtils, ppmm, gMap, libcutils, UUIDGenerator */

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");

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

const SE_IPC_SECUREELEMENT_MSG_NAMES = [
  "SE:GetSEReaders",
  "SE:OpenChannel",
  "SE:CloseChannel",
  "SE:TransmitAPDU",
  "SE:ACETest"
];

const SECUREELEMENTMANAGER_CONTRACTID =
  "@mozilla.org/secureelement/parent-manager;1";
const SECUREELEMENTMANAGER_CID =
  Components.ID("{48f4e650-28d2-11e4-8c21-0800200c9a66}");
const NS_XPCOM_SHUTDOWN_OBSERVER_ID = "xpcom-shutdown";

XPCOMUtils.defineLazyServiceGetter(this, "ppmm",
                                   "@mozilla.org/parentprocessmessagemanager;1",
                                   "nsIMessageBroadcaster");

XPCOMUtils.defineLazyServiceGetter(this, "UiccConnector",
                                   "@mozilla.org/secureelement/connector;1",
                                   "nsISecureElementConnector");

XPCOMUtils.defineLazyServiceGetter(this, "UUIDGenerator",
                                   "@mozilla.org/uuid-generator;1",
                                   "nsIUUIDGenerator");

XPCOMUtils.defineLazyModuleGetter(this, "SEUtils",
                                  "resource://gre/modules/SEUtils.jsm");

const PREFERRED_UICC_CLIENTID =
  libcutils.property_get("ro.moz.se.def_client_id", "0");

function getConnector(type) {
  switch (type) {
    case SE.TYPE_UICC:
      return UiccConnector;
    case SE.TYPE_ESE:
    default:
      debug("UnSupported SEConnector : " + type);
      return null;
  }
}

/**
 * 'gMap' is a nested dictionary object that manages all the information
 * pertaining to channels for a given application (appId). It manages the
 * relationship between given application and its opened channels.
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
        channels : {
          [token: // (key = 'aaaaa')
            seType: // 'uicc' or 'eSE'
            aid :
            channel : ]
          [token: // (key = 'bbbbb')
            seType:
            aid :
            channel : ]
          [token: // (key = 'ccccc')
            seType:
            aid :
            channel :]
        }] // End of 'channels'
    [appId : // (key = '1025')
        ...
        ...
        ...
    ]} */
    appInfoMap: {},

    // Register the new SecureElement target.
    registerSecureElementTarget: function(message, readers) {
      let appId = message.data.appId;
      if (this.appInfoMap[appId]) {
        debug("Already registered SE target! appId:" + appId);
        return;
      }
      this.appInfoMap[appId] = {
        target: message.target,
        readerTypes: readers,
        channels: {}
      };

      debug("Registering a new SE target " + appId);
    },

    // UnRegister the SecureElement target.
    unregisterSecureElementTarget: function(target) {
      let appId = this.getAppIdByTarget(target);
      if (appId) {
        debug("Unregistered SE Target for AppId : " + appId);
        delete this.appInfoMap[appId];
      }
    },

    // Gets all the channels in an array for the given appId
    getAllChannelsByAppId: function(appId) {
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channels : " + appId);
        return [];
      }

      let channels = appInfo.channels || {};
      return Object.keys(channels).map(cKey => channels[cKey].channel);
    },

    // Gets channel count associated with the 'appId'
    getChannelCount: function(appId) {
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channel count: " + appId);
        return 0;
      }
      return Object.keys(appInfo.channels).length;
    },

    // Add channel to the appId. Upon successfully adding the entry
    // this function will return the 'token'
    addChannel: function(channel, msg) {
      let appInfo = this.appInfoMap[msg.appId];
      if (!appInfo) {
        debug("Unable to add channel: " + msg.appId);
        return null;
      }
      // Generate a unique 'token' (alias) instead of sending 'channel number'.
      // to the content. Any further 'Channel' related operations by the content
      // shall operate using this token.
      let token = UUIDGenerator.generateUUID().toString();
      // Add the entry
      appInfo.channels[token] = { seType: msg.type, aid: msg.aid, channel:  channel };
      return token;
    },

    // Remove the given channel entry based on type.
    // Note that channel will be unique per type
    removeChannel: function(channel, type) {
      Object.keys(this.appInfoMap).forEach((appId) => {
        let channels = this.appInfoMap[appId].channels;
        let token = Object.keys(channels).find((ch) => {
          return channels[ch].channel === channel &&
                 channels[ch].seType === type;
        });

        if (token) {
          debug("Deleting channel with token : " + token +
                ",  channel : " +  channel);
          delete channels[token];
        }
      });
    },

    // Validates the given 'channelToken' by checking if it is a registered one
    // for the given (appId, channelToken)
    isValidChannelToken: function(data) {
      let { appId: appId, channelToken: chToken } = data;

      // appId needs to be present
      if (!appId || !this.appInfoMap[appId]) {
        return false;
      }
      if (chToken &&
          !this.appInfoMap[appId].channels[chToken]) {
        return false;
      }

      return true;
    },

    // Get the 'channel' associated with (appId, channelToken)
    getChannel: function(data) {
      if (!this.isValidChannelToken(data)) {
        debug("InValid Channel Token. Unable to get the channel");
        return null;
      }

      return this.appInfoMap[data.appId].channels[data.channelToken].channel;
    },

    getAppIdByTarget: function(target) {
      let appId = Object.keys(this.appInfoMap).find((id) => {
        return this.appInfoMap[id] && this.appInfoMap[id].target === target;
      });

      return appId;
    },
  };
});

/**
 * 'SecureElementManager' is the main object that handles IPC messages from
 * child process. It interacts with other objects such as 'gMap' & 'Connector
 * instances (UiccConnector, eSEConnector)' to perform various
 * SE-related (open,close,transmit) operations.
 */
function SecureElementManager() {
  this._registerMessageListeners();

  // Initialize handlers array
  this.handlers["SE:OpenChannel"] = this.handleOpenChannel;
  this.handlers["SE:CloseChannel"] = this.handleCloseChannel;
  this.handlers["SE:TransmitAPDU"] = this.handleTransmit;

  Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);

  this.accessControlEnforcer =
    Cc["@mozilla.org/secureelement/access-control/ace;1"]
    .getService(Ci.nsIAccessControlEnforcer);
}

SecureElementManager.prototype = {
  QueryInterface: XPCOMUtils.generateQI([
    Ci.nsIMessageListener,
    Ci.nsIObserver]),
  classID: SECUREELEMENTMANAGER_CID,
  classInfo: XPCOMUtils.generateCI({
    classID:          SECUREELEMENTMANAGER_CID,
    classDescription: "SecureElementManager",
    interfaces:       [Ci.nsIMessageListener,
                       Ci.nsIObserver]
  }),

  handlers: [],
  accessControlEnforcer: null,

  _shutdown: function() {
    this.secureelement = null;
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

  // Private function used to retreive available readerNames
  _getAvailableReaders: function() {
    let readerTypes = [];
    // TODO 1: Bug 1118096 - Add IDL so that other sub-systems such as RIL ,
    // NFC can implement it.
    // TODO 2: Bug 1118097 - According to OpenMobile spec, the reader names
    // should support slot based naming convention.
    // i;e; Instead of returning 'uicc', return 'uicc<slot#>'.
    readerTypes.push(SE.TYPE_UICC);
    return readerTypes;
  },

  _closeAllChannelsByAppId: function(appId, type, callback) {
    let channels = gMap.getAllChannelsByAppId(appId);
    if (channels.length === 0) {
      debug("No channels to close.");
      if(callback) {
        callback({
          error: SE.ERROR_BADSTATE,
          reason: "No Active Channels to be closed!"
        });
      }
      return;
    }

    let connector = getConnector(type);
    // Counter to keep track of callbacks received from 'Connector'.
    let cbCnt = 0;
    channels.forEach((channel) => {
      debug("Attempting to Close Channel # : " + channel);

      connector.closeChannel(PREFERRED_UICC_CLIENTID, channel, {
        notifyCloseChannelSuccess: () => {
          debug("notifyCloseChannelSuccess # : " + channel);
          // Remove the channel entry from the map, since this channel
          // has been successfully closed
          gMap.removeChannel(channel, type);
          if (callback && (++cbCnt === channels.length)) {
            callback({ error: SE.ERROR_NONE });
          }
        },

        notifyError: (reason) => {
          debug("Failed to close the channel #  : " + channel +
                ", Rejected with Reason : " + reason);
          if (callback && (++cbCnt === channels.length)) {
            callback({ error: SE.ERROR_BADSTATE, reason: reason });
          }
        }
      });
    });
  },

  // Following functions are handlers for requests from content

  handleOpenChannel: function(msg, callback) {
    // Perform Sanity Checks!
    if (gMap.getChannelCount(msg.appId) >=
        SE.MAX_CHANNELS_ALLOWED_PER_SESSION) {
      debug("Max channels per session exceed !!!");
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    this.accessControlEnforcer.isAccessAllowed(msg.appId, msg.type, msg.aid)
    .then((allowed) => {
      if (!allowed) {
        if (callback) {
          callback({ error: SE.ERROR_SECURITY });
        }
        return;
      }

      let connector = getConnector(msg.type);
      connector.openChannel(PREFERRED_UICC_CLIENTID,
        SEUtils.byteArrayToHexString(msg.aid), {

        notifyOpenChannelSuccess: (channel, openResponse) => {
          // Add the new 'channel' to the map upon success
          let channelToken = gMap.addChannel(channel, msg);
          if (callback) {
            callback({
              error: SE.ERROR_NONE,
              channelToken: channelToken,
              isBasicChannel: (channel === SE.BASIC_CHANNEL),
              openResponse: SEUtils.hexStringToByteArray(openResponse)
            });
          }
        },

        notifyError: (reason) => {
          debug("Failed to open the channel to AID : " +
                 SEUtils.byteArrayToHexString(msg.aid) +
                 ", Rejected with Reason : " + reason);
          if (callback) {
            callback({ error: SE.ERROR_GENERIC, reason: reason, response: [] });
          }
        }
      });
    })
    .catch((error) => {
      debug("Failed to get info from accessControlEnforcer " + error);
      if (callback) {
        callback({ error: SE.ERROR_SECURITY });
      }
    });
  },

  handleTransmit: function(msg, callback) {
    // Perform basic sanity checks!
    if (!gMap.isValidChannelToken(msg)) {
      debug("Invalid token:" + msg.channelToken + ", appId: " + msg.appId );
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module
    let connector = getConnector(msg.type);
    connector.exchangeAPDU(PREFERRED_UICC_CLIENTID, gMap.getChannel(msg),
                           msg.apdu.cla, msg.apdu.ins, msg.apdu.p1, msg.apdu.p2,
                           SEUtils.byteArrayToHexString(msg.apdu.data),
                           msg.apdu.le, {
      notifyExchangeAPDUResponse: (sw1, sw2, response) => {
        if (callback) {
          callback({
            error: SE.ERROR_NONE,
            sw1: sw1,
            sw2: sw2,
            response: SEUtils.hexStringToByteArray(response)
          });
        }
      },

      notifyError: (reason) => {
        debug("Transmit failed, rejected with Reason : " + reason);
        if (callback) {
          callback({ error: SE.ERROR_INVALIDAPPLICATION, reason: reason });
        }
      }
    });
  },

  handleCloseChannel: function(msg, callback) {
    // Perform Sanity Checks!
    if (!gMap.isValidChannelToken(msg)) {
      debug("Invalid token:" + msg.channelToken + ", appId:" + msg.appId);
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module
    let connector = getConnector(msg.type);
    let channel = gMap.getChannel(msg);
    connector.closeChannel(PREFERRED_UICC_CLIENTID, channel, {
      notifyCloseChannelSuccess: () => {
        gMap.removeChannel(channel, msg.type);
        if (callback) {
          callback({ error: SE.ERROR_NONE });
        }
      },

      notifyError: (reason) => {
        debug("Failed to close channel:" + channel + ", reason: " + reason);
        if (callback) {
          callback({ error: SE.ERROR_BADSTATE, reason: reason });
        }
      }
    });
  },

  handleGetSEReadersRequest: function(msg) {
    // TODO: Bug 1118101 Get supported readerTypes based on the permissions
    // available for the given.
    let seReaderTypes = this._getAvailableReaders();
    gMap.registerSecureElementTarget(msg, seReaderTypes);
    let options = {
      result: { readerTypes: seReaderTypes },
      metadata: msg.data
    };
    msg.target.sendAsyncMessage(msg.name + "Resolved", options);
  },

  handleRequest: function(msg) {
    let handler = this.handlers[msg.name].bind(this);
    handler(msg.data, function(result) {
      let promiseStatus = (result.error === SE.ERROR_NONE) ? "Resolved"
                                                           : "Rejected";
      let options = { result: result, metadata: msg.data };
      msg.target.sendAsyncMessage(msg.name + promiseStatus, options);
    });
  },

  handleChildProcessShutdown: function(target) {
    let appId = gMap.getAppIdByTarget(target);
    if (!appId) {
      return;
    }
    this._closeAllChannelsByAppId(appId, SE.TYPE_UICC, null);
    gMap.unregisterSecureElementTarget(target);
  },

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
    debug("Received '" + msg.name + "' message from content process" +
          ": " + JSON.stringify(msg.data));
    if (msg.name == "child-process-shutdown") {
      // By the time we receive child-process-shutdown, the child process has
      // already forgotten its permissions so we need to unregister the target
      // for every permission.
      this.handleChildProcessShutdown(msg.target);
      return null;
    }

    if (SE_IPC_SECUREELEMENT_MSG_NAMES.indexOf(msg.name) != -1) {
      if (!msg.target.assertPermission("secureelement-manage")) {
        debug("SecureElement message " + msg.name + " from a content process " +
              "with no 'secureelement-manage' privileges.");
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
      case "SE:OpenChannel":
      case "SE:CloseChannel":
      case "SE:TransmitAPDU":
        this.handleRequest(msg);
        break;
      case "SE:ACETest":
        this.testAce(msg);
        break;
    }
    return null;
  },

  testAce: function(msg) {
    let ace = Cc["@mozilla.org/secureelement/access-control/ace;1"]
              .getService(Ci.nsIAccessControlEnforcer);

    ace.isAccessAllowed(msg.data.appId, "uicc", new Uint8Array())
    .then((result) => {
      debug("got response from ACE: " + result);
      let options = { result: result, metadata: msg.data };
      msg.target.sendAsyncMessage(msg.name + "Resolved", options);
    })
    .catch((error) => {
      debug("got error from ACE: " + error);
      let options = { result: error, metadata: msg.data };
      msg.target.sendAsyncMessage(msg.name + "Rejected", options);
    });
  },

  /**
   * nsIObserver interface methods.
   */

  observe: function(subject, topic, data) {
    if (topic === NS_XPCOM_SHUTDOWN_OBSERVER_ID) {
      this._shutdown();
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElementManager]);

