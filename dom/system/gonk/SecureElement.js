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
const FAILURE = 1;

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
     { [appId :// appId 1 (key)
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

  ready: false,

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
      return FAILURE;
    }
    appInfo.sessions[sessionId] = { type: type,
                                    channels: {} };
    return SUCCESS;
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
    let aid = msg.json.aid;
    if (channel ==  0) {
      // Is it basic channel ? If so, we are not supporting it
      return false;
    }

    if(this.appInfoMap[appId].sessions[sessionId].channels[channelToken].channel === channel) {
       return true;
    }
    debug('Not a valid Channel' + channelToken);
    return false;
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

  _getPDUCommand: function(command) {
    let apduCmd = new Uint8Array(command.length);
    apduCmd[0] = command[0] & 0xff; //cla
    apduCmd[1] = command[1] & 0xff; //ins
    apduCmd[2] = command[2] & 0xff; //p1
    apduCmd[3] = command[3] & 0xff; //p2
    if (apduCmd[4] != 0) {
      apduCmd[4] = command[4] & 0xff; //p3
      for (let index = 4; (index < apduCmd[4]) && (index < apduCmd.length); index++) {
        apduCmd[index] = command[index]; //data
      }
    }
    return apduCmd;
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

  _closeAllChannelsByAppId: function(appId, callback) {
    let status = SUCCESS;
    let channels = this._getAllChannelsByAppId(appId);

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
    let status = SUCCESS;
    let channelNumber = 1;
    // 1. Validate the AID with ACE
    // 2. channelNumber = iccOpenChannel(aid);
    //let number = iccProvider.iccOpenChannel(1,
    let token = UUIDGenerator.generateUUID().toString();
    // TBD: don't rely on cardstate yet
    if (((this.cardState === CARDSTATE_READY) || true) && (data.type === 'uicc')) {
      status |= this._addChannelToSession(channelNumber, token, data);
    }

    if (callback)
      callback(status, token);
  },

  _closeChannel: function(data, callback) {
    let status = FAILURE;
    let token = data.channelToken;
    let sessionId = data.sessionId;
    let appId = data.appId;
    let channelNumber = this.appInfoMap[appId].sessions[sessionId].channels[token].channel
    if (channelNumber !== undefined) {
      debug('Channel # to be closed ' + channelNumber);
      status = SUCCESS;
      //iccCloseChannel(clientId, channelNumber , null);
    }
    if (callback)
      callback(status);
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

  /**
   * nsIMessageListener interface methods.
   */

  receiveMessage: function(msg) {
     debug("Received '" + msg.name + "' message from content process" + ": " + JSON.stringify(msg.json));
    let status = FAILURE;
    let token = null;
    let sessionId = null;
    let message = msg;
    let self = this;
    let promiseStatus;
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
        // TBD: don't rely on cardstate yet
        if (this.cardState === CARDSTATE_READY || true) {
	  secureelements.push('uicc');
        }
        if (secureelements.length == 0) {
	  debug("No active SecureElements present");
        } else {
	  this._registerMessageTarget(msg);
        }
        promiseStatus = (secureelements.length > 0) ? "Resolved" : "Rejected";
        msg.target.sendAsyncMessage(msg.name+promiseStatus, {
                                    secureelements: secureelements,
                                    resolverId: msg.json.resolverId
                                    });
        break;
      case "SE:OpenSession":
        let clientId = 1;
        // TBD: don't rely on cardstate yet
        if (((this.cardState === CARDSTATE_READY) || true) && (msg.json.type === 'uicc')) { 
	  sessionId = UUIDGenerator.generateUUID().toString();
	  status = this._addSessionToTarget(sessionId, msg);
        }
        promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
        msg.target.sendAsyncMessage(msg.name+promiseStatus, {
                                    sessionId: sessionId,
                                    type: msg.json.type,
                                    resolverId: msg.json.resolverId
                                    });
        break;
      case "SE:OpenChannel":
        this._openChannel(msg.json, function(status, token) {
          promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
          msg.target.sendAsyncMessage(message.name+promiseStatus, {
                                      status: status,
                                      aid: message.json.aid,
                                      channelToken: token,
                                      sessionId: message.json.sessionId,
                                      resolverId: message.json.resolverId
                                      });
        });
        break;
      case "SE:TransmitAPDU":
        let okRespApdu = [0x00, 0x01, 0x02, 0x03, 0x90, 0x00];
      
        let command = msg.json.apdu;
        let apduCmd = this._getPDUCommand(command);
        let channel = this._getChannelNumber(command[0]);

        promiseStatus = (true === this._isChannelRegistered(channel, msg)) ? "Resolved" : "Rejected";
        msg.target.sendAsyncMessage(msg.name+promiseStatus, {
                                    status: status,
                                    resolverId: msg.json.resolverId,
                                    channelToken: msg.json.channelToken,
                                    respApdu: okRespApdu
                                    });
        break;
      case "SE:CloseChannel":
        this._closeChannel(msg.json, function(status) {
	  promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
	  message.target.sendAsyncMessage(message.name+promiseStatus, {
                                          status: status,
                                          aid: msg.json.aid,
                                          resolverId: msg.json.resolverId
			                  });
	});
        break;
      case "SE:CloseAllByReader":
        this._closeAllChannelsByAppId(msg.json.appId, function(status) {
          promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
          if (status == FAILURE) {
            debug("Oops! Too bad, XXX Memory Leak? XXX : Unable to close (all) channel(s) held by the AppId : " + message.json.appId);
          }
          let thisReaderSession = self.appInfoMap[message.json.appId].sessions;
          // clear this session info
          if (thisReaderSession !== undefined)
            thisReaderSession = {};
          message.target.sendAsyncMessage(message.name+promiseStatus, {
                                          resolverId: message.json.resolverId
                                          });
        });
        break;
      case "SE:CloseAllBySession":
        this._closeAllChannelsBySessionId(msg.json.sessionId, msg.json.appId, function(status) {
          promiseStatus = (status === SUCCESS) ? "Resolved" : "Rejected";
          let thisSession = self.appInfoMap[message.json.appId].sessions[message.json.sessionId];
          // clear this session info
          if (thisSession !== undefined && thisSession.type === message.json.type)
            thisSession = {};
          message.target.sendAsyncMessage(message.name+promiseStatus, {
                                      resolverId: message.json.resolverId
                                      });
        });
        break;
      default:
        throw new Error("Don't know about this message: " + msg.name);
        break;
    }
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
     let present = ((this.cardState !== null) && (notReadyStates.indexOf(this.cardState) > -1)) ? true : false;
     this._notifyAllTargetsOnSEStateChange("uicc", present);
     debug("CardStateChanged: " + this.cardState + "present : " + present);
   },

   notifyIccInfoChanged: function() {}
  };
});

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SecureElement]);

