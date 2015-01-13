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

/* globals dump, Components, XPCOMUtils, SE, Services,
   SEUtils, ppmm, gMap, libcutils */

const {classes: Cc, interfaces: Ci, utils: Cu } = Components;

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
function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement: " + s + "\n");
  }
}

const SE_IPC_SECUREELEMENT_MSG_NAMES = [
  "SE:GetSEReaders",
  "SE:OpenChannel",
  "SE:CloseChannel",
  "SE:TransmitAPDU"
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

// TODO: Bug 1118099  - Add multi-sim support.
// In the Multi-sim, there is more than one client.
// For now, use default clientID as 0. Ideally, SE parent process would like to
// know which clients (uicc slot) are connected to CLF over SWP interface.
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
 * Note that an application (appId / content) can open multiple channels with a
 * secure element
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

    uuidGenerator: null,

    // Register the new SecureElement target.
    registerSecureElementTarget: function(message, readers) {
      let appInfoMap = this.appInfoMap;
      let appId = message.data.appId;
      let targetInfo = appInfoMap[appId];

      // If the application Id is already registered
      if (targetInfo) {
        debug("Already registered SE target! " + appId);
        return;
      }
      let newAppInfo = { target: message.target,
                         readerTypes: readers,
                         channels: {} };
      appInfoMap[appId] = newAppInfo;
      debug("Registering a new SE target " + appId);
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
          debug("Unregistered SE Target for AppId : " + appId);
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

    // Gets all the channels in an array for the given appId
    getAllChannelsByAppId: function(appId) {
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to get channels : " + appId);
        return [];
      }

      return this._getChannels(appInfo.channels);
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
      let appId = msg.appId;
      let appInfo = this.appInfoMap[appId];
      if (!appInfo) {
        debug("Unable to add channel: " + appId);
        return null;
      }
      // Generate a unique 'token' (alias) instead of sending 'channel number'.
      // to the content. Any further 'Channel' related operations by the content
      // shall operate using this token.
      let token = this._getUUIDGenerator().generateUUID().toString();
      // Add the entry
      appInfo.channels[token] = { seType: msg.type, aid: msg.aid, channel:  channel };
      return token;
    },

    // Remove the given channel entry based on type.
    // Note that 'channel' will be unique per type
    // @todo refactoring needed
    removeChannel: function(channel, type) {
      let targets = this.appInfoMap;
      Object.keys(targets).forEach((appId) => {
        let channels = targets[appId].channels;
        Object.keys(channels).forEach((token) => {
          if (channels[token].channel ===  channel &&
              channels[token].seType === type) {
              // We have found the match
              debug("Deleting channel with token : " + token +
                    ",  channel : " +  channel);
              delete channels[token];
          }
        }); // End of Channels keys
      }); // End of AppId keys
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

    // Returns an array of channels like [2,3,4] from appInfo.channels object.
    // If no 'channel entry' exists in 'channels it returns an empty array '[]'
    // @todo consider removing
    _getChannels: function(channels) {
      channels = channels || {};
      return Object.keys(channels).map(cKey => channels[cKey].channel);
    },

    // @todo remove, use XPCOMUtils.defineLazyServiceGetter instead
    _getUUIDGenerator: function() {
      if (!this.uuidGenerator) {
        this.uuidGenerator = Cc["@mozilla.org/uuid-generator;1"]
                             .createInstance(Ci.nsIUUIDGenerator);
      }
      return this.uuidGenerator;
    },
  };
});

/**
 * 'SecureElementManager' is the main object that interfaces with
 * child process / content. It is also the 'message manager' of the module.
 * It interacts with other objects such as 'gMap' & 'Connector instances
 * (UiccConnector, eSEConnector)' to perform various operations.
 * It mainly interacts with 'gMap' to query the state of Channels,
 * while it interacts with 'Connector instances' to perform low
 * level SE-related (open,close,transmit) I/O operations.
 */
function SecureElementManager() {
  this._registerMessageListeners();

  // Initialize handlers array
  this.handlers["SE:OpenChannel"] = this.handleOpenChannel;
  this.handlers["SE:CloseChannel"] = this.handleCloseChannel;
  this.handlers["SE:TransmitAPDU"] = this.handleTransmit;

  Services.obs.addObserver(this, NS_XPCOM_SHUTDOWN_OBSERVER_ID, false);
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

  _setChannelToClassByte(cla, channel) {
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

  _closeAllChannelsByAppId: function(appId, type, callback) {
    let allChannels = gMap.getAllChannelsByAppId(appId);
    return this.closeAll(type, allChannels, callback);
  },

  // Closes all the channels for a given type
  // @todo replace for with forEach
  // @todo notifyChannelSuccess, notifyError should be defined
  // outside the loop
  closeAll: function(type, channels, callback) {
    if (channels.length === 0) {
      return callback ? callback({ error: SE.ERROR_BADSTATE,
			reason: "No Active Channels to be closed!" }) : null;
    }

    let connector = getConnector(type);
    let cbCnt = 0;
    for (let index = 0; index < channels.length; index++) {
      let channel = channels[index];
      if (!channel) {
	continue;
      }
      debug("Attempting to Close Channel # : " + channel);

      connector.closeChannel(PREFERRED_UICC_CLIENTID, channel, {
	notifyCloseChannelSuccess: function() {
	  debug("notifyCloseChannelSuccess # : " + channel);
          // Remove the channel entry from the map, since this channel
          // has been successfully closed
          gMap.removeChannel(channel, type);
	  if (callback && (++cbCnt === channels.length)) {
	    callback({ error: SE.ERROR_NONE });
	  }
	},

	notifyError: function(reason) {
	  debug("Failed to close the channel #  : " + channel +
		", Rejected with Reason : " + reason);
	  if (callback && (++cbCnt === channels.length)) {
	    callback({ error: SE.ERROR_BADSTATE, reason: reason });
	  }
	}
      });
    }
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

    // TODO: Bug 1118098  - Integrate with ACE module

    // Sanity passed! Create Connector obj based on the 'type'
    let connector = getConnector(msg.type);
    connector.openChannel(PREFERRED_UICC_CLIENTID,
      SEUtils.byteArrayToHexString(msg.aid), {
      notifyOpenChannelSuccess: function(channel, openResponse) {
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

      notifyError: function(reason) {
        debug("Failed to open the channel to AID : " +
               SEUtils.byteArrayToHexString(msg.aid) +
               ", Rejected with Reason : " + reason);
        if (callback) {
          callback({ error: SE.ERROR_IO, reason: reason, response: [] });
        }
      }
    });
  },

  handleTransmit: function(msg, callback) {
    // Perform basic sanity checks!
    if (!gMap.isValidChannelToken(msg)) {
      debug("Invalid Token - " + msg.channelToken +
            ", [appId: " + msg.appId + " ]");
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module

    // Set the channel to CLA before calling connector's exchangeAPDU.
    // See GP Spec, 11.1.4 Class Byte Coding
    let channel = gMap.getChannel(msg);
    msg.apdu.cla = this._setChannelToClassByte(msg.apdu.cla, channel);
    let connector = getConnector(msg.type);
    connector.exchangeAPDU(PREFERRED_UICC_CLIENTID, msg.apdu.cla,
                           msg.apdu.ins, msg.apdu.p1, msg.apdu.p2,
                           SEUtils.byteArrayToHexString(msg.apdu.data),
                           msg.apdu.le, {
      notifyExchangeAPDUResponse: function(sw1, sw2, response) {
        if (callback) {
          callback({ error: SE.ERROR_NONE, sw1: sw1, sw2: sw2,
            response: SEUtils.hexStringToByteArray(response) });
        }
      },

      notifyError: function(reason) {
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
      debug("Invalid Token - " + msg.channelToken +
            ", [appId: " + msg.appId + " ]");
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module

    // Sanity passed! Create Connector obj based on the 'type'
    let connector = getConnector(msg.type);
    let channel = gMap.getChannel(msg);
    connector.closeChannel(PREFERRED_UICC_CLIENTID, channel, {
      notifyCloseChannelSuccess: function() {
        gMap.removeChannel(channel, msg.type);
        if (callback) {
          callback({ error: SE.ERROR_NONE });
        }
      },

      notifyError: function(reason) {
        debug("Failed to close the channel #  : " + channel +
              ", Rejected with Reason : " + reason);
        if (callback) {
          callback({ error: SE.ERROR_BADSTATE, reason: reason });
        }
      }
    });
  },

  // 1. Query the map to get 'appInfo' based on 'msg.target'.
  //    (appInfo.appId & appInfo.readerTypes)
  // 2. Iterate over all registered readerTypes and close all channels by type.
  // 3. Finally unregister the target from 'gMap' by deleting its entry.
  // @todo for -> forEach
  handleChildProcessShutdown: function(target) {
    let appInfo = gMap.getAppInfoByMsgTarget(target);
    if (!appInfo) {
      return;
    }
    this._closeAllChannelsByAppId(appInfo.appId, SE.TYPE_UICC, null);
    gMap.unregisterSecureElementTarget(target);
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

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
    DEBUG && debug("Received '" + msg.name + "' message from content process" +
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
    }
    return null;
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

