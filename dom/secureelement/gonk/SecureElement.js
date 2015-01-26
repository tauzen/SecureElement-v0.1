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
   SEUtils, ppmm, gMap, UUIDGenerator */

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

XPCOMUtils.defineLazyServiceGetter(this, "UUIDGenerator",
                                   "@mozilla.org/uuid-generator;1",
                                   "nsIUUIDGenerator");

XPCOMUtils.defineLazyModuleGetter(this, "SEUtils",
                                  "resource://gre/modules/SEUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "UiccConnector", () => {
  let uiccConnectorClass = Cc["@mozilla.org/secureelement/connector/uicc;1"];
  if (uiccConnectorClass) {
    return uiccConnectorClass.createInstance(Ci.nsISecureElementConnector);
  }

  return null;
});

function getConnector(type) {
  switch (type) {
    case SE.TYPE_UICC:
      return UiccConnector;
    case SE.TYPE_ESE:
    default:
      debug("Unsupported SEConnector : " + type);
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
    // example structure of AppInfoMap
    // {
    //   "appId1": {
    //     target: target1,
    //     readerType: ["uicc", "eSE"],
    //     channels: {
    //       "channelToken1": {
    //         seType: "uicc",
    //         aid: "aid1",
    //         channelNumber: 1
    //       },
    //       "channelToken2": { ... }
    //     }
    //   },
    //  "appId2": { ... }
    // }
    appInfoMap: {},

    registerSecureElementTarget: function(appId, readers, target) {
      if (this.appInfoMap[appId]) {
        debug("Already registered SE target! appId:" + appId);
        return;
      }

      this.appInfoMap[appId] = {
        target: target,
        readerTypes: readers,
        channels: {}
      };

      debug("Registered a new SE target " + appId);
    },

    unregisterSecureElementTarget: function(appId) {
      if (this.appInfoMap[appId]) {
        debug("Unregistered SE Target for AppId : " + appId);
        delete this.appInfoMap[appId];
      }
    },

    // Gets all the channels in an array for the given appId and type
    getChannelNumbersByAppIdType: function(appId, type) {
      let aInfo = this.appInfoMap[appId];
      if (!aInfo) {
        debug("Unable to get channels : " + appId);
        return [];
      }

      return Object.keys(aInfo.channels)
                   .filter(c => type ? aInfo.channels[c].seType === type : true)
                   .map(cKey => aInfo.channels[cKey].channelNumber);
    },

    getChannelCountByAppIdType: function(appId, type) {
      return this.getChannelNumbersByAppIdType(appId, type).length;
    },

    // Add channel to the appId. Upon successfully adding the entry
    // this function will return the 'token'
    addChannel: function(appId, type, aid, channelNumber) {
      if (!this.appInfoMap[appId]) {
        debug("Unable to add channel, no such appId: " + appId);
        return null;
      }

      let token = UUIDGenerator.generateUUID().toString();
      this.appInfoMap[appId].channels[token] = {
        seType: type,
        aid: aid,
        channelNumber: channelNumber
      };
      return token;
    },

    // Remove the given channel entry based on type.
    // Note that channel will be unique per type
    removeChannel: function(appId, channelNumber, type) {
      let channels = this.appInfoMap[appId].channels;
      let token = Object.keys(channels).find((ch) => {
        return channels[ch].channelNumber === channelNumber &&
               channels[ch].seType === type;
      });

      if (token) {
        debug("Deleting channel with token : " + token +
              ",  channel : " +  channelNumber);
        delete channels[token];
      }
    },

    // Get the channel number associated with (appId, channelToken)
    getChannelNumber: function(appId, channelToken) {
      if (!this.appInfoMap[appId] ||
          !this.appInfoMap[appId].channels[channelToken]) {
        return null;
      }

      return this.appInfoMap[appId].channels[channelToken].channelNumber;
    },

    getAppIdByTarget: function(target) {
      let appId = Object.keys(this.appInfoMap).find((id) => {
        return this.appInfoMap[id].target === target;
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
  _getAvailableReaderTypes: function() {
    let readerTypes = [];
    // TODO 1: Bug 1118096 - Add IDL so that other sub-systems such as RIL ,
    // NFC can implement it.
    // TODO 2: Bug 1118097 - According to OpenMobile spec, the reader names
    // should support slot based naming convention.
    // i;e; Instead of returning 'uicc', return 'uicc<slot#>'.

    if (UiccConnector) {
      readerTypes.push(SE.TYPE_UICC);
    }

    return readerTypes;
  },

  handleOpenChannel: function(msg, callback) {
    // Perform Sanity Checks!
    if (gMap.getChannelCountByAppIdType(msg.appId, msg.type) >=
        SE.MAX_CHANNELS_ALLOWED_PER_SESSION) {
      debug("Max channels per session exceed !!!");
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module
    let connector = getConnector(msg.type);
    if (!connector) {
      if (callback) {
        callback({ error: SE.ERROR_NOTPRESENT });
      }
      debug("No SE connector available");
      return;
    }

    connector.openChannel(SEUtils.byteArrayToHexString(msg.aid), {
      notifyOpenChannelSuccess: (channelNumber, openResponse) => {
        // Add the new 'channel' to the map upon success
        let channelToken =
          gMap.addChannel(msg.appId, msg.type, msg.aid, channelNumber);
        if (callback && channelToken) {
          callback({
            error: SE.ERROR_NONE,
            channelToken: channelToken,
            isBasicChannel: (channelNumber === SE.BASIC_CHANNEL),
            openResponse: SEUtils.hexStringToByteArray(openResponse)
          });
        } else if(callback && !channelToken) {
          callback({ error: SE.ERROR_GENERIC });
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
  },

  handleTransmit: function(msg, callback) {
    let channelNumber = gMap.getChannelNumber(msg.appId, msg.channelToken);

    if (!channelNumber) {
      debug("Invalid token:" + msg.channelToken + ", appId: " + msg.appId);
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    let connector = getConnector(msg.type);
    if (!connector) {
      if (callback) {
        callback({ error: SE.ERROR_NOTPRESENT });
      }
      debug("No SE connector available");
      return;
    }

    connector.exchangeAPDU(channelNumber, msg.apdu.cla, msg.apdu.ins,
                           msg.apdu.p1, msg.apdu.p2,
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
    let channelNumber = gMap.getChannelNumber(msg.appId, msg.channelToken);

    if (!channelNumber) {
      debug("Invalid token:" + msg.channelToken + ", appId:" + msg.appId);
      if (callback) {
        callback({ error: SE.ERROR_GENERIC });
      }
      return;
    }

    let connector = getConnector(msg.type);
    if (!connector) {
      if (callback) {
        callback({ error: SE.ERROR_NOTPRESENT });
      }
      debug("No SE connector available");
      return;
    }

    connector.closeChannel(channelNumber, {
      notifyCloseChannelSuccess: () => {
        gMap.removeChannel(msg.appId, channelNumber, msg.type);
        if (callback) {
          callback({ error: SE.ERROR_NONE });
        }
      },

      notifyError: (reason) => {
        debug("Failed to close channel: " + channelNumber +
              ", reason: "+ reason);
        if (callback) {
          callback({ error: SE.ERROR_BADSTATE, reason: reason });
        }
      }
    });
  },

  handleGetSEReadersRequest: function(msg, target, callback) {
    // TODO: Bug 1118101 Get supported readerTypes based on the permissions
    // available for the given application.
    let seReaderTypes = this._getAvailableReaderTypes();
    gMap.registerSecureElementTarget(msg.appId, seReaderTypes, target);
    callback({ readerTypes: seReaderTypes, error: SE.ERROR_NONE });
  },

  // performs clean up of UICC channels only
  // TODO implement closing of other SE channel types (when available)
  handleChildProcessShutdown: function(target) {
    let appId = gMap.getAppIdByTarget(target);
    if (!appId) {
      return;
    }

    let channelNumbers = gMap.getChannelNumbersByAppIdType(appId, SE.TYPE_UICC);
    if (channelNumbers.length === 0) {
      debug("No channels to close.");
      gMap.unregisterSecureElementTarget(appId);
      return;
    }

    let connector = getConnector(SE.TYPE_UICC);
    if (!connector) {
      debug("No SE connector available");
      return;
    }

    channelNumbers.forEach((channel) => {
      debug("Attempting to Close Channel #" + channel);

      connector.closeChannel(channel, {
        notifyCloseChannelSuccess: () => {
          debug("notifyCloseChannelSuccess #" + channel);
        },

        notifyError: (reason) => {
          debug("Failed to close the channel #" + channel +
                ", Rejected with Reason : " + reason);
        }
      });
    });

    gMap.unregisterSecureElementTarget(appId);
  },

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
    DEBUG && debug("Received '" + msg.name + "' message from content process" +
                   ": " + JSON.stringify(msg.data));

    if (msg.name === "child-process-shutdown") {
      this.handleChildProcessShutdown(msg.target);
      return null;
    }

    if (SE_IPC_SECUREELEMENT_MSG_NAMES.indexOf(msg.name) !== -1) {
      if (!msg.target.assertPermission("secureelement-manage")) {
        debug("SecureElement message " + msg.name + " from a content process " +
              "with no 'secureelement-manage' privileges.");
        return null;
      }
    } else {
      debug("Ignoring unknown message type: " + msg.name);
      return null;
    }

    let callback = (result) => this.sendSEResponse(msg, result);
    switch (msg.name) {
      case "SE:GetSEReaders":
        this.handleGetSEReadersRequest(msg.data, msg.target, callback);
        break;
      case "SE:OpenChannel":
        this.handleOpenChannel(msg.data, callback);
        break;
      case "SE:CloseChannel":
        this.handleCloseChannel(msg.data, callback);
        break;
      case "SE:TransmitAPDU":
        this.handleTransmit(msg.data, callback);
        break;
    }
    return null;
  },

  sendSEResponse: function(msg, result) {
    let promiseStatus = (result.error === SE.ERROR_NONE) ? "Resolved" : "Rejected";
    let options = { result: result, metadata: msg.data };
    msg.target.sendAsyncMessage(msg.name + promiseStatus, options);
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
