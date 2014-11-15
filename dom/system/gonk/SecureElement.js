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

let DEBUG = true;

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/systemlibs.js");
Cu.import("resource://gre/modules/Promise.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

const SE_IPC_SECUREELEMENT_MSG_NAMES = [
  "SE:GetSEReaders",
  "SE:OpenSession",
  "SE:OpenChannel",
  "SE:CloseChannel",
  "SE:TransmitAPDU",
  "SE:CloseAllByReader",
  "SE:CloseAllBySession"
];

function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement: " + s + "\n");
  }
}

const SE_CONTRACTID = "@mozilla.org/se;1";
const SE_CID =
  Components.ID("{48f4e650-28d2-11e4-8c21-0800200c9a66}");
const NS_XPCOM_SHUTDOWN_OBSERVER_ID    = "xpcom-shutdown";

// MUST match with cardstates in nsIIccProvider.idl
const CARDSTATE_READY = 1; // Treat any other state as error

const SUCCESS = 0;
const FAILURE = -1;

const MAX_CHANNELS_ALLOWED_PER_SESSION = 4;



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

  classID:   SE_CID,
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
               msg.target :
               sessions : { [11111 : // sessionId 1 (key)
                                    type :
                                    channels : { [aaaaa: // 'token' 1 (key)
                                                         aid :
                                                         channelNumber : ]
                                                 [bbbbb: // 'token' 2 (key)
                                                         aid :
                                                         channelNumber : ]
                                                 [ccccc: // 'token' 3 (key)
                                                         aid :
                                                         channelNumber : ]
                                               }
                            ]
                            [22222 : // sessionId 2 (key)
                                    type :
                                    channels : { [ddddd: // 'token' 1 (key)
                                                         aid :
                                                         channelNumber : ]
                                                 [eeeee: // 'token' 2 (key)
                                                         aid :
                                                         channelNumber : ]
                                                 [fffff: // 'token' 3 (key)
                                                         aid :
                                                         channelNumber : ]
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
                                      }
                        } ]
       ]
     }
  */
  appInfoMap: {},

  cardReady: true,

  cardState: null,

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
    // Attach a listener to UICC state changes (clientId: 0)
    iccProvider.registerIccMsg(1, this);

    // TBD: Initialize eSE listener here
  },

  _uninitializeSEListeners: function() {
    // Detach the listener to UICC state changes (clientId: 0)
    iccProvider.unregisterIccMsg(1, this);

    // TBD: Uninitialize eSE listener here
  },

  _registerMessageTarget: function(message) {
    let appInfoMap = this.appInfoMap;
    let appId = message.json.appId;
    let isAlreadyRegistered = false;
    for(let i = 0; i < appInfoMap.length; i++) {
      if (appInfoMap[i].appId === appId) {
        isAlreadyRegistered = true;
        debug("Already registered this target!" + appId);
        break;
      }
    }
    if (!isAlreadyRegistered) {
      let newAppInfo = { target: message.target,
                         sessions: {} };
      appInfoMap[appId] = newAppInfo;
      debug("Registering a new target " + appId);
    }
  },

  _unregisterMessageTarget: function(message) {
    let targets = this.appInfoMap;
    Object.keys(targets).forEach((appId) => {
      let targetInfo = targets[appId];
      if (targetInfo && targetInfo.target === message.target) {
        // Remove the target from the list of registered targets
        debug("Unregisterd MessageTarget for AppId : " + appId);
        this._closeAllChannelsByAppId(targets[appId], function(status) {
          if (status == FAILURE) {
            debug("Oops! Too bad, XXX Memory Leak? XXX : Unable to close (all) channel(s) held by the AppId : " + appId);
          }
          delete targets[appId];
        });
        return;
      }
    });
  },

  _addSessionToTarget: function(sessionId, msg) {
    let appId = msg.json.appId;
    let type = msg.json.type;

    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      debug("Unable to add session to the target: " + appId);
      return;
    }
    appInfo.sessions[sessionId] = { type: type,
                                    channels: {} };
  },

  _addChannelToSession: function(channel, token, data) {
    let appId = data.appId;
    let sessionId = data.sessionId;
    let aid = data.aid;
    let type = data.type;
    let status = FAILURE;

    let appInfo = this.appInfoMap[appId];
    if (!appInfo) {
      debug("Unable to add session to the target: " + appId);
      return status;
    }
    let session = appInfo.sessions[sessionId];
    if (!session) {
      debug("Unable to get session " + sessionId + " for the target: " + appId);
      return status;
    }

    for(let i = 0; i < session.channels.length; i++) {
      if ((channel === session.channels.channel) ||
         (aid === session.channels.aid)) {
         debug("Channel (or) AID already exists for this session :" + sessionId
                  + " - Channel :" + channel + " " + session.channels.channel
                  + " - AID :" + aid + " " + session.channels.aid);
        return status;
      }
    }

    // TBD if (session.channels.length <= MAX_CHANNELS_ALLOWED_PER_SESSION) 
    if (session.type === type) {
      session.channels[token] = { channel: channel,
                                  aid: aid };
      status = SUCCESS;
    } else {
      debug("Number of Channels : " +  session.channels.length +
            " Session Type " + session.type + " vs " + type + " for sessionId: " + sessionId);
    }

    return status;
  },

  _isChannelRegistered: function(channel, msg) {
    let appId = msg.json.appId; 
    let sessionId = msg.json.sessionId;
    let channelToken = msg.json.channelToken;

    if (channel ==  0) {
      // Is it basic channel ? If so, we are not supporting it
      return false;
    }

    if(this.appInfoMap[appId].sessions[sessionId].channels[channelToken].channel === channel) {
       return true;
    }
    debug('Not a valid Channel Token - ' + channelToken);
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

  _getAllChannelsBySessionId: function(sessionId, appId) {
    let sessions = this.appInfoMap[appId].sessions[sessionId];
    if (!sessions) {
      debug("Unable to get session for the target appId : " + appId + " sessionId: " + sessionId);
      return null;
    }
    return this._getChannels(sessions.channels);
  },

  _getChannels: function(channels) {
    if (channels == 'undefined' || channels == null)
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

  _getChannel: function(msg) {
    let appId = msg.json.appId;
    let sessionId = msg.json.sessionId;
    let channelToken = msg.json.channelToken;
    let aid = msg.json.aid;

    return this.appInfoMap[appId].sessions[sessionId].channels[channelToken].channel;

  },

  _getChannelNumber: function(cla) {
    // As per GlobalPlatform Card Specification v2.2, check the 7th bit
    let classByteCoding = (cla & 0x40);
    if(classByteCoding == 0x00) {
      // If 7 th bit is not set, then channel number is encoded in the 2 rightmost bits
      // Refer to section 11.1.4.1. Possible logical channel numbers are (00: 0, 01 : 1, 10 : 2, 11 : 3)
      return cla & 0x03;
    } else {
      // If the 7th bit is set, channel number is encoded in the 4 rightmost bits
      // Refer to section  11.1.4.2. Note that Supplementary Logical Channels start from 4 to 19. So add 4
      return (cla & 0x0F) + 4;
    }
  },

  _setChannelToClassByte(cla, channelNumber) {
    if (channelNumber < 4) {
      // b7 = 0 indicates the first interindustry class byte coding
      cla = (((cla & 0x9C) & 0x0F) | channelNumber);
    } else if (channelNumber < 20) {
      // b7 = 1 indicates the further interindustry class byte coding
      cla = (((cla & 0xB0) & 0x0F) | 0x40 | (channelNumber - 4));
    } else {
	debug("Channel number must be within [0..19]");
        return FAILURE;
    }
    return cla;
  },

  _closeAllChannelsByAppId: function(appId, callback) {
    let status = SUCCESS;
    let clientId = 1;
    let channels = this._getAllChannelsByAppId(appId);
    let count = 0;

    do {
      if (channels == null || channels.length == 0) {
        status |= FAILURE;
        break;
      }

      for (let channelNumber in channels) {
        debug('Close Channel # - ' + channelNumber);
        iccProvider.iccCloseChannel(clientId, channelNumber , {
	  notifyOpenChannelSuccess: function(channel) {},

	  notifyCloseChannelSuccess: function() {
            ++ count;
            status |= SUCCESS;
            if (callback && (count == channels.length))
	      callback({ status: status });
          },

	  notifyError: function(error) {
            ++ count;
            status |= FAILURE;
            if (callback && (count == channels.length))
	      callback({ status: status, error: error });
	  }
	});
      }
    } while(false);

    if (callback)
      callback(status);
  },

  _closeAllChannelsBySessionId: function(sessionId, appId, callback) {
    let status = SUCCESS;
    let channels = this._getAllChannelsBySessionId(sessionId, appId);
    do {
      if (channels == null || channels.length == 0)
        break;
      for (let channelNumber in channels) {
        //iccProvider.iccCloseChannel(1, channelNumber, null);
      }
   } while(false);

    if (callback)
      callback(status);
  },

  _openChannel: function(data, callback) {
    let clientId = 1;
    let status = FAILURE;
    // TBD: Validate the AID 'data.aid' with ACE
    iccProvider.iccOpenChannel(clientId, this._byte2hexString(data.aid) , {
      notifyOpenChannelSuccess: function(channel) {
	let token = UUIDGenerator.generateUUID().toString();
	if (((this.cardState === CARDSTATE_READY) || true) && (data.type === 'uicc')) {
	  status = gSEMessageManager._addChannelToSession(channel, token, data);
	}
	if (callback) {
	  callback({ status: status,
                     token : token });
	}
      },

      notifyError: function(error) {
        callback({ status: status, error: error });
      }
    });
  },

  _transmit: function(msg, apduCmd, callback) {
    let clientId = 1;
    let channel = this._getChannelNumber(apduCmd[0] & 0xFF);
    debug('transmit on Channel # - ' + channel);
    // TBD: Validate the AID 'data.aid' with ACE
    let cla = apduCmd[0] & 0xFF;
    let ins = apduCmd[1] & 0xFF;
    let p1 = apduCmd[2] & 0xFF;
    let p2 = apduCmd[3] & 0xFF;
    let lc = ((apduCmd[4] === 0) || (apduCmd[4] === undefined)) ? 0 : (apduCmd[4] & 0xFF);
    let data = ( lc > 0 ) ? apduCmd.subarray(5) : null;
    iccProvider.iccExchangeAPDU(clientId, channel , (cla & 0xFC), ins, p1, p2, lc, data, {
      notifyExchangeAPDUResponse: function(sw1, sw2, length, simResponse) {
        callback({ sw1: sw1, sw2: sw2, simResponse: simResponse });
      },

      notifyError: function(error) {
        callback({ status: status, error: error });
      }
    });
  },

  _closeChannel: function(data, callback) {
    let clientId = 1;
    let token = data.channelToken;
    let sessionId = data.sessionId;
    let appId = data.appId;
    let channelNumber = this.appInfoMap[appId].sessions[sessionId].channels[token].channel;

    if (channelNumber !== undefined) {
      debug('Channel # to be closed ' + channelNumber);
      iccProvider.iccCloseChannel(clientId, channelNumber , {
        notifyCloseChannelSuccess: function() {
          if (callback) {
	    callback({ status: SUCCESS });
	  }
        },

        notifyError: function(error) {
	  callback({ status: FAILURE, error: error });
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
		                            present: isPresent
		                            });
      }
    });
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
     debug("Received '" + msg.name + "' message from content process" + ": " + JSON.stringify(msg.json));
    let status = FAILURE;
    let token = null;
    let sessionId = null;
    let message = msg;
    let promiseStatus = "Rejected";
    let options = { status : status,
                    resolverId: msg.json.resolverId };
    let self = this;
    if (msg.name == "child-process-shutdown") {
      // By the time we receive child-process-shutdown, the child process has
      // already forgotten its permissions so we need to unregister the target
      // for every permission.
      this._unregisterMessageTarget(msg);
      return null;
    }

    if (SE_IPC_SECUREELEMENT_MSG_NAMES.indexOf(msg.name) != -1) {
      if (!msg.target.assertPermission("secureelement-manage")) {
        if (DEBUG) {
          debug("SecureElement message " + msg.name +
                " from a content process with no 'secureelement-manage' privileges.");
        }
        return null;
      }
    } else {
      debug("Ignoring unknown message type: " + msg.name);
      return null;
    }

    switch (msg.name) {
      case "SE:GetSEReaders":
        let secureelements = [];
        if (this.cardReady) {
          this._registerMessageTarget(msg);
	  secureelements.push('uicc');
          options = { secureelements: secureelements,
                      resolverId: msg.json.resolverId };
          promiseStatus = "Resolved";
        }
        break;
      case "SE:OpenSession":
        if ((this.cardReady) && (msg.json.type === 'uicc')) { 
	  sessionId = UUIDGenerator.generateUUID().toString();
	  this._addSessionToTarget(sessionId, msg);
          options = { sessionId: sessionId,
                      type: msg.json.type,
                      resolverId: msg.json.resolverId };
          promiseStatus = "Resolved";
        }
        break;
      case "SE:OpenChannel":
        this._openChannel(msg.json, function(result) {
          debug('In _openChannel CALLBACL CALLED status - ' + result.status + '  ' + result.token);
          promiseStatus = (result.status === SUCCESS) ? "Resolved" : "Rejected";
          options = { aid: message.json.aid,
                      channelToken: result.token,
                      sessionId: message.json.sessionId,
                      resolverId: message.json.resolverId
                    };
          message.target.sendAsyncMessage(message.name+promiseStatus, options);
        });
        // Send the response when in the callback, for now return!
        return;
      case "SE:TransmitAPDU":
        let command = msg.json.apdu;
        let channel = this._getChannel(msg);
        command[0] = this._setChannelToClassByte(command[0], channel);
        this._transmit(msg, command, function(result) {
          promiseStatus = (result.sw1 === 144 && result.sw2 === 0) ? "Resolved" : "Resolved";
          options = { channelToken: message.json.channelToken,
                      respApdu: result,
                      resolverId: message.json.resolverId
                    };
          message.target.sendAsyncMessage(message.name+promiseStatus, options);
        });
        // Send the response when in the callback, for now return!
        return;
      case "SE:CloseChannel":
        this._closeChannel(msg.json, function(result) {
          options = { aid: msg.json.aid,
                      channelToken: token,
                      sessionId: message.json.sessionId,
                      resolverId: msg.json.resolverId
                    };
          promiseStatus = (result.status === SUCCESS) ? "Resolved" : "Rejected";
          message.target.sendAsyncMessage(message.name+promiseStatus, options);
	});
        // Send the response when in the callback, for now return!
        return;
      case "SE:CloseAllBySession":
        this._closeAllChannelsBySessionId(msg.json.sessionId, msg.json.appId, function(status) {
          promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
          let thisSession = self.appInfoMap[message.json.appId].sessions[message.json.sessionId];
          // clear this session info
          if (thisSession !== undefined && thisSession.type === message.json.type)
          thisSession = {};
          options = { sessionId: message.json.sessionId,
                      resolverId: message.json.resolverId };
        });
        // Send the response when in the callback, for now return!
        return;
      case "SE:CloseAllByReader":
        this._closeAllChannelsByAppId(msg.json.appId, function(status) {
          promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
          let thisReaderSession = self.appInfoMap[message.json.appId].sessions;
          // clear this session info
          if (thisReaderSession !== undefined)
            thisReaderSession = {};
          options = { type: msg.json.type,
                      resolverId: message.json.resolverId };
          message.target.sendAsyncMessage(message.name+promiseStatus, options);
        });
        // Send the response when in the callback, for now return!
        return;
      default:
        throw new Error("Don't know about this message: " + msg.name);
        return;
    }
    msg.target.sendAsyncMessage(msg.name+promiseStatus, options);
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
     // TBD: In the Multi-sim, there is more than one client in iccProvider. 
     // For now, use client 1. Ideally, we would like to know which clients (uicc slot)
     // is connected to CLF over SWP interface.
     let clientId = 1;
     // Consider following Card states as not quite ready for issuing IccChannel* related commands
     let notReadyStates = [
       "unknown",
       "illegal",
       "personalizationInProgress",
       "permanentBlocked"
     ];
     this.cardState = iccProvider.getCardState(clientId);
     this.cardReady = ((this.cardState !== null) && (notReadyStates.indexOf(this.cardState) == -1)) ? true : false;
     this._notifyAllTargetsOnSEStateChange("uicc", this.cardReady);
     libcutils.property_set('persist.check.se', this.cardReady + ' ' + this.cardState);
     libcutils.property_set('persist.check.se1', 'hurrah');
     debug("CardStateChanged: " + this.cardState + "CardReady : " + this.cardReady);
   },

   notifyIccInfoChanged: function() {}
  };
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElement]);

