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

XPCOMUtils.defineLazyGetter(this, "SE", () => {
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
  let uiccClass = Cc["@mozilla.org/secureelement/connector/uicc;1"];
  return uiccClass ? uiccClass.getService(Ci.nsISecureElementConnector) : null;
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

    registerSecureElementTarget: function(appId, readerTypes, target) {
      this.appInfoMap[appId] = {
        target: target,
        readerTypes: readerTypes,
        channels: {}
      };

      debug("Registered a new SE target " + appId);
    },

    unregisterSecureElementTarget: function(target) {
      let appId = Object.keys(this.appInfoMap).find((id) => {
        return this.appInfoMap[id].target === target;
      });

      if (!appId) {
        return;
      }

      debug("Unregistered SE Target for AppId: " + appId);
      delete this.appInfoMap[appId];
    },

    isAppIdRegistered: function(appId) {
      return this.appInfoMap[appId] !== undefined;
    },

    getChannelCountByAppIdType: function(appId, type) {
      if (!this.isAppIdRegistered(appId)) {
        debug("Unable to get channels : " + appId);
        return 0;
      }

      return Object.keys(this.appInfoMap[appId].channels)
                   .reduce((cnt, ch) => ch.type === type ? ++cnt : cnt, 0);
    },

    // Add channel to the appId. Upon successfully adding the entry
    // this function will return the 'token'
    addChannel: function(appId, type, aid, channelNumber) {
      let token = UUIDGenerator.generateUUID().toString();
      this.appInfoMap[appId].channels[token] = {
        seType: type,
        aid: aid,
        channelNumber: channelNumber
      };
      return token;
    },

    removeChannel: function(appId, channelToken) {
      if (this.appInfoMap[appId].channels[channelToken]) {
        debug("Deleting channel with token : " + channelToken);
        delete this.appInfoMap[appId].channels[channelToken];
      }
    },

    getChannel: function(appId, channelToken) {
      if (!this.appInfoMap[appId].channels[channelToken]) {
        return null;
      }

      return this.appInfoMap[appId].channels[channelToken];
    },

    getChannelsByTarget: function(target) {
      let appId = Object.keys(this.appInfoMap).find((id) => {
        return this.appInfoMap[id].target === target;
      });

      if (!appId) {
        return [];
      }

      return Object.keys(this.appInfoMap[appId].channels)
                   .map(token => this.appInfoMap[appId].channels[token]);
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

  _canOpenChannel: function(appId, type) {
    let opened = gMap.getChannelCountByAppIdType(appId, type);
    let limit = SE.MAX_CHANNELS_ALLOWED_PER_SESSION;
    // UICC basic channel is not accessible see comment in se_consts.js
    limit = type === SE.TYPE_UICC ? limit - 1 : limit;
    return opened < limit;
  },

  _handleOpenChannel: function(msg, callback) {
    if (!this._canOpenChannel(msg.aid, msg.type)) {
      debug("Max channels per session exceed");
      callback({ error: SE.ERROR_GENERIC });
      return;
    }

    // TODO: Bug 1118098  - Integrate with ACE module
    let connector = getConnector(msg.type);
    if (!connector) {
      debug("No SE connector available");
      callback({ error: SE.ERROR_NOTPRESENT });
      return;
    }

    connector.openChannel(SEUtils.byteArrayToHexString(msg.aid), {
      notifyOpenChannelSuccess: (channelNumber, openResponse) => {
        // Add the new 'channel' to the map upon success
        let channelToken =
          gMap.addChannel(msg.appId, msg.type, msg.aid, channelNumber);
        if (channelToken) {
          callback({
            error: SE.ERROR_NONE,
            channelToken: channelToken,
            isBasicChannel: (channelNumber === SE.BASIC_CHANNEL),
            openResponse: SEUtils.hexStringToByteArray(openResponse)
          });
        } else {
          callback({ error: SE.ERROR_GENERIC });
        }
      },

      notifyError: (reason) => {
        debug("Failed to open the channel to AID : " +
               SEUtils.byteArrayToHexString(msg.aid) +
               ", Rejected with Reason : " + reason);
        callback({ error: SE.ERROR_GENERIC, reason: reason, response: [] });
      }
    });
  },

  _handleTransmit: function(msg, callback) {
    let channel = gMap.getChannel(msg.appId, msg.channelToken);
    if (!channel) {
      debug("Invalid token:" + msg.channelToken + ", appId: " + msg.appId);
      callback({ error: SE.ERROR_GENERIC });
      return;
    }

    let connector = getConnector(channel.seType);
    if (!connector) {
      debug("No SE connector available");
      callback({ error: SE.ERROR_NOTPRESENT });
      return;
    }

    connector.exchangeAPDU(channel.channelNumber, msg.apdu.cla, msg.apdu.ins,
                           msg.apdu.p1, msg.apdu.p2,
                           SEUtils.byteArrayToHexString(msg.apdu.data),
                           msg.apdu.le, {
      notifyExchangeAPDUResponse: (sw1, sw2, response) => {
        callback({
          error: SE.ERROR_NONE,
          sw1: sw1,
          sw2: sw2,
          response: SEUtils.hexStringToByteArray(response)
        });
      },

      notifyError: (reason) => {
        debug("Transmit failed, rejected with Reason : " + reason);
        callback({ error: SE.ERROR_INVALIDAPPLICATION, reason: reason });
      }
    });
  },

  _handleCloseChannel: function(msg, callback) {
    let channel = gMap.getChannel(msg.appId, msg.channelToken);
    if (!channel) {
      debug("Invalid token:" + msg.channelToken + ", appId:" + msg.appId);
      callback({ error: SE.ERROR_GENERIC });
      return;
    }

    let connector = getConnector(channel.seType);
    if (!connector) {
      debug("No SE connector available");
      callback({ error: SE.ERROR_NOTPRESENT });
      return;
    }

    connector.closeChannel(channel.channelNumber, {
      notifyCloseChannelSuccess: () => {
        gMap.removeChannel(msg.appId, msg.channelToken);
        callback({ error: SE.ERROR_NONE });
      },

      notifyError: (reason) => {
        debug("Failed to close channel with token: " + msg.channelToken +
              ", reason: "+ reason);
        callback({ error: SE.ERROR_BADSTATE, reason: reason });
      }
    });
  },

  _handleGetSEReadersRequest: function(msg, target, callback) {
    // TODO: Bug 1118101 Get supported readerTypes based on the permissions
    // available for the given application.
    let seReaderTypes = this._getAvailableReaderTypes();
    gMap.registerSecureElementTarget(msg.appId, seReaderTypes, target);
    callback({ readerTypes: seReaderTypes, error: SE.ERROR_NONE });
  },

  _handleChildProcessShutdown: function(target) {
    let channels = gMap.getChannelsByTarget(target);

    let createCb = (seType, channelNumber) => {
      return {
        notifyCloseChannelSuccess: () => {
          debug("closed " + seType + ", channel " + channelNumber);
        },

        notifyError: (reason) => {
          debug("Failed to close  " + seType + " channel " +
                channelNumber + ", reason: " + reason);
        }
      };
    };

    channels.forEach((channel) => {
      let connector = getConnector(channel.seType);
      if (!connector) {
        return;
      }

      connector.closeChannel(channel.channelNumber,
                             createCb(channel.seType, channel.channelNumber));
    });

    gMap.unregisterSecureElementTarget(target);
  },

  _sendSEResponse: function(msg, result) {
    let promiseStatus = (result.error === SE.ERROR_NONE) ? "Resolved" : "Rejected";
    result.resolverId = msg.data.resolverId;
    msg.target.sendAsyncMessage(msg.name + promiseStatus, {result: result});
  },

  _isValidMessage: function(msg) {
    let appIdValid = gMap.isAppIdRegistered(msg.data.appId);
    return msg.name === "SE:GetSEReaders" ? !appIdValid : appIdValid;
  },

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
    DEBUG && debug("Received '" + msg.name + "' message from content process" +
                   ": " + JSON.stringify(msg.data));

    if (msg.name === "child-process-shutdown") {
      this._handleChildProcessShutdown(msg.target);
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

    let callback = (result) => this._sendSEResponse(msg, result);
    if (!this._isValidMessage(msg)) {
      debug("Message not valid");
      callback({ error: SE.ERROR_GENERIC });
      return null;
    }

    switch (msg.name) {
      case "SE:GetSEReaders":
        this._handleGetSEReadersRequest(msg.data, msg.target, callback);
        break;
      case "SE:OpenChannel":
        this._handleOpenChannel(msg.data, callback);
        break;
      case "SE:CloseChannel":
        this._handleCloseChannel(msg.data, callback);
        break;
      case "SE:TransmitAPDU":
        this._handleTransmit(msg.data, callback);
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
