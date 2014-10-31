/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2014, Deutsche Telekom, Inc. */

"use strict";

const DEBUG = true;
function debug(s) {
  if (DEBUG) {
    dump("-*- SecureElement DOM: " + s + "\n");
  }
}

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "cpmm",
                                   "@mozilla.org/childprocessmessagemanager;1",
                                   "nsISyncMessageSender");

XPCOMUtils.defineLazyServiceGetter(this, "iccProvider",
                   "@mozilla.org/ril/content-helper;1",
                   "nsIIccProvider");

const SE_TYPE_SIM = 0x00;
const SE_TYPE_ESE  = 0x01;

/*
 * Helper object that maintains sessionObj and its corresponding channelObj for a given SE type
 */
let SEStateHelper = {

  /*
     ------------------------------
       Structure of 'stateInfoMap':
     ------------------------------
     { ['uicc' :
                 reader : readerObj1
                 sessions :
                           { [xxxxx : // 'session' 1 (key)
                                     channels : { [aaaaa: // 'token' 1 (key)
                                                           channelObj 1 ]
                                                  [bbbbb: // 'token' 2 (key)
                                                           channelObj 2 ]
                                                }
                             ]
                             [yyyyy : // 'session' 2 (key)
                                     channels : { [aaaaa: // 'token' 3 (key)
                                                           channelObj 3 ]
                                                  [bbbbb: // 'token' 4 (key)
                                                           channelObj 4 ]
                                                }
                             ]
                          } // End of 'sessions'
       ]
       [ 'eSE' :
                 reader : readerObj2
                 sessions :
                              { [..... : ..]
                                [..... : ..]
                              }
       ]
     }
  */

  _stateInfoMap: {},

  addReaderObjs(readerObjs) {
    for (let index = 0; index < readerObjs.length; readerObjs++) {
      let aReaderObj = readerObjs[index];
      let sessionObj = { reader: aReaderObj,
                         sessions: {} };
      this._stateInfoMap[aReaderObj.type] = sessionObj;
    }
  },
 
  getReaderObjByType(type) {
    return this._stateInfoMap[type].reader;
  },

  deleteReaderObjByType(type) {
    let sessions = this._stateInfoMap[type].sessions;
    Object.keys(sessions).forEach((sessionId) => {
      if (sessions[sessionId] !== undefined)
        delete this.deleteSessionObjById(sessionId);
    });
  },

  addSessionObj(sessionObj, sessionId, type) {
    this._stateInfoMap[type].sessions[sessionId] = { session: sessionObj,
                                                     channels: {} };
  },

  getSessionObjById(sessionId) {
    let sessionObj = null;
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[sessionId] !== undefined)
        sessionObj = sessions[sessionId].session;
       return;
    });
    return sessionObj;
  },

  deleteSessionObjById(sessionId) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[sessionId] !== undefined) {
        let channels = sessions[sessionId].channels;
        Object.keys(channels).forEach((aToken) => {
          this.deleteChannelObjByToken(sessionId, aToken);
        });
        // TBD: Check if there is a race condition here!
        sessions[sessionId].session.isClosed = true;
        delete sessions[sessionId].session;
      }
    });
  },

  addChannelObj(channelObj, sessionId, channelToken) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[sessionId] !== undefined) {
        sessions[sessionId].channels[channelToken] = channelObj;
      }
    });
  },

  getChannelObjByToken(channelToken) {
    let channelObj = null;
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      Object.keys(sessions).forEach((sessionId) =>  {
        let channels = sessions[sessionId].channels;
        if (channels[channelToken] !== undefined) {
          channelObj = channels[channelToken];
          return;
        }
      });
    });
    return channelObj;
  },

  deleteChannelObjByToken(sessionId, channelToken) {
    Object.keys(this._stateInfoMap).forEach((aType) => {
      let sessions = this._stateInfoMap[aType].sessions;
      if (sessions[sessionId] !== undefined &&
          sessions[sessionId].channels[channelToken] !== undefined) {
        sessions[sessionId].channels[channelToken].isClosed = true;
        delete sessions[sessionId].channels[channelToken];
      }
    });
  }
};

function PromiseHelpersSubclass(win) {
   this._window = win;
}
PromiseHelpersSubclass.prototype = {
  _window: null,

  __proto__: DOMRequestIpcHelper.prototype,

  _createPromise: function(aCallback) {
    return this.createPromise((aResolve, aReject) => {
      let resolverId = this.getPromiseResolverId({
        resolve: aResolve,
        reject: aReject
      });
      // TBD: On some condition, say
      if (false) {
        this.removePromiseResolver(resolverId);
        aReject('SEManager is not active.');
        return;
      }
      aCallback(resolverId);
    });
  }
};

// Helper class to create promises
let PromiseHelpers;

/**
 * ==============================================
 * SECommand
 * ==============================================
 */
function SECommand(cla, ins, p1, p2, data, len) {
  debug('In SECommand Constructor');
}

SECommand.prototype = {
  __init: function (cla, ins, p1, p2, data, len) {
    this.cla = cla;
    this.ins = ins;
    this.p1 = p1;
    this.p2 = p2;
    this.data = data
    this.len = len;
  },

  classID: Components.ID("{cb8ccb1c-0e99-4a62-bf7d-11acc13848e0}"),
  contractID: "@mozilla.org/secureelement/SECommand;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports]),
};

/**
 * ==============================================
 * SEResponse
 * ==============================================
 */

function SEResponse(win, respApdu, channelObj) {
  this._window = win;
  this.sw1 = 0x00;
  this.sw2 = 0x00;
  this.data = null;
  this.status = 0;
  this.channel = channelObj;
  if (respApdu.length < 2) {
    debug('Response APDU : Invalid length ' + respApdu.length);
    return;
  }

  if (respApdu.length > 2) {
    this.data = respApdu.slice(0, respApdu.length - 2);
  }
  this.sw1 = 0x00FF & respApdu[respApdu.length - 2];
  this.sw2 = 0x00FF & respApdu[respApdu.length - 1];
  this.status = (this.sw1 << 8) | this.sw2;
}

SEResponse.prototype = {
  classID: Components.ID("{58bc6c7b-686c-47cc-8867-578a6ed23f4e}"),
  contractID: "@mozilla.org/secureelement/SEResponse;1",
  QueryInterface: XPCOMUtils.generateQI([]),
};

/**
 * ==============================================
 * SEChannel
 * ==============================================
 */

function SEChannel(win, aid, channelToken, sessionObj, sessionId) {
  this._window       = win;
  this._aid          = aid;
  this._channelToken = channelToken;
  this._sessionId    = sessionId;
  this.session       = sessionObj;
  this.isClosed      = false;
}

SEChannel.prototype = {
  classID: Components.ID("{181ebcf4-5164-4e28-99f2-877ec6fa83b9}"),
  contractID: "@mozilla.org/secureelement/SEChannel;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  transmit: function(command) {
    let index = 0;
    
    //debug("In transmit len: " + command.length);
    // TBD: Verify the sanctity of 'pdu'
    if (command == null) {
      throw new Error("Invalid APDU");
    }
    // Len: 10 ==> CLA (1 Byte) + INS (1 Byte) + P1 (1 Byte) + P2 (1 Byte)  + Lc (3 Bytes) + data is null (0 Bytes) + Le (Resp bytes, 3 Bytes) 
    // Len: 266 ==> 256 (Max data PDU) + 10 bytes (for above mentioned headers)
    let maxLen = 10; //command.data? 10 : 266;
    let array = new Uint8Array(maxLen);

    if (this.isClosed) {
      throw new Error("Channel Already Closed!");
    }    

    array[0] = (command.cla);
    array[1] = (command.ins);
    array[2] = (command.p1);
    array[3] = (command.p2); 
    array[4] = 0x00; // len of data
  

    if (array.length < 4) {
      throw new Error("SECommand sanity fails!");
    }
    // Clone data object using structured clone algorithm.
    //let apdu = Cu.cloneInto(array, this._window);
   
    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:TransmitAPDU", {
        resolverId: aResolverId,
        apdu: array,
        channelToken: this._channelToken,
        aid: this._aid,
        sessionId: this._sessionId,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  close: function() {
    if (this.isClosed) {
      throw new Error("Session Already Closed!");
    }

    this.isClosed = true;
    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseChannel", {
        resolverId: aResolverId,
        aid: this._aid,
        channelToken: this._channelToken,
        sessionId: this._sessionId,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  }
};

/**
 * ==============================================
 * SESession
 * ==============================================
 */

function SESession(win, readerObj, sessionId) {
  this._window       = win;
  this._sessionId    = sessionId;
  this.reader        = readerObj;
  this.isClosed      = false;
}

SESession.prototype = {
  classID: Components.ID("{2b1809f8-17bd-4947-abd7-bdef1498561c}"),
  contractID: "@mozilla.org/secureelement/SESession;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  openBasicChannel: function(aid) {
    debug("NOT IMPLEMENTED!!!")
  },

  openLogicalChannel: function(aid) {
    if(aid == null || aid.length == 0) {
      // TBD: Should this be treated as default application selection ?
    }
    if (this.isClosed) {
      throw new Error("Session Already Closed!");
    }
    if (aid) {
      this.aid = Cu.cloneInto(aid, this._window);
    }

   // Uncomment following code if you need to test latest QCOM build. Below code snippet
   // only serves as a proof of concept

/*
    let aidStr = '325041592E5359532E4444463031';
    let request  = iccProvider.iccOpenChannel(1, this._window , aidStr );
    request.onsuccess = function onsuccess() {
       debug("In openLogicalChannel onsuccess 1--- ");
            // CLA=0x00,  INS=0xa4, P1=0x00, p2=0x04, Lc=0x02, Data=0x5031
            //var apdu = { cla: 0x00, command: 0xa4, p1: 0x00, p2: 0x04, path: null, Lc: 0x02, data: 0x5031, data2: null};

            // cla:80, INS: D4, p1: 01, p2:00, Lc:00
            var apdu = { cla: 0x80, command: 0xD4, p1: 0x01, p2: 0x00, path: null, Lc: 0x00, data2: null};
       	    let request1  = iccProvider.iccExchangeAPDU(1, self._window , 2,  apdu);
            let _self = self;
	    request1.onsuccess = function onsuccess() {
	            debug("In iccExchangeAPDU onsuccess 2");

                    //  CLA=0x00,  INS=0xb0, P1=0x00, p2=0x00, Le=0x00
                    var apdu1 = { cla: 0x92, command: 0xb0, p1: 0x00, p2: 0x00, path: null };
	       	    let request2  = iccProvider.iccExchangeAPDU(1, _self._window , 2,  apdu1);
                    let __self = _self;
		    request2.onsuccess = function onsuccess() {
                        debug("In iccExchangeAPDU onsuccess 2.1");
			let request3  = iccProvider.iccCloseChannel(1, __self._window , 2 );
			request3.onsuccess = function onsuccess() {
			  debug("In iccCloseChannel onsuccess 3");
			};
			request3.onerror = function onerror() {
			  debug("In iccCloseChannel onerror 3");
			};
		    };
                    
		    request2.onerror = function onerror() {
                        debug("In iccExchangeAPDU onerror 2.1");
                        
		    };
               
	    };
	    request1.onerror = function onerror() {
	      debug("In iccExchangeAPDU onerror 2");
	    };
    };

    request.onerror = function onerror() {
      debug("In openLogicalChannel onerror 1");
    };
*/
    

    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:OpenChannel", {
        resolverId: aResolverId,
        aid: aid,
        sessionId: this._sessionId,
        type: this.reader.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function() {
    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseAllBySession", {
        resolverId: aResolverId,
        sessionId: this._sessionId,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  }
};

/**
 * ==============================================
 * SEReader
 * ==============================================
 */

function SEReader(win, aType) {
  this._window = win;
  this.type    = aType;
  this.isSEPresent = true;
}

SEReader.prototype = {
  _window: null,

  classID: Components.ID("{1c7bdba3-cd35-4f8b-a546-55b3232457d5}"),
  contractID: "@mozilla.org/secureelement/SEReader;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  openSession: function() {
    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:OpenSession", {
        resolverId: aResolverId,
        type: this.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function() {
    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:CloseAllByReader", {
        resolverId: aResolverId,
        type: this.type,
        appId: this._window.document.nodePrincipal.appId
      });
    });
  }
};

/**
 * ==============================================
 * SEManager
 * ==============================================
 */
function SEManager() {}

SEManager.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,

  _window: null,

  _isAllowed: false,

  classID: Components.ID("{4a8b6ec0-4674-11e4-916c-0800200c9a66}"),
  contractID: "@mozilla.org/navigatorSEManager;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDOMGlobalPropertyInitializer,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver]),

  init: function SEManagerInit(win) {
    this._window = win;
    PromiseHelpers = new PromiseHelpersSubclass(this._window);
    this.innerWindowID = win.QueryInterface(Ci.nsIInterfaceRequestor)
                            .getInterface(Ci.nsIDOMWindowUtils)
                            .currentInnerWindowID;

    let principal = win.document.nodePrincipal;
    let perm = Services.perms.testExactPermissionFromPrincipal(principal,
                                                               "secureelement-manage");
    if (perm === Ci.nsIPermissionManager.ALLOW_ACTION) {
      this._isAllowed = true;
    }

    // Add the messages to be listened to.
    const messages = ["SE:GetSEReadersResolved",
                      "SE:OpenSessionResolved",
                      "SE:OpenChannelResolved",
                      "SE:CloseChannelResolved",
                      "SE:TransmitAPDUResolved",
                      "SE:CloseAllByReaderResolved",
                      "SE:CloseAllBySessionResolved",
                      "SE:GetSEReadersRejected",
                      "SE:OpenSessionRejected",
                      "SE:OpenChannelRejected",
                      "SE:CloseChannelRejected",
                      "SE:TransmitAPDURejected",
                      "SE:CloseAllByReaderRejected",
                      "SE:CloseAllBySessionRejected",
                      "SE:NotifySEStateChange"];

    this.initDOMRequestHelper(win, messages);
  },

  uninit: function SEManagerUninit() {
    this.destroyDOMRequestHelper();
    this._window = null;
  },

  _ensureAccess: function() {
    if (!this._isAllowed) {
      throw new this._window.DOMError("Security Exception!",
                                      "Should have 'secureelement-manage' permssion.");
    }
  },

  getSEReaders: function() {
    this._ensureAccess();
    return PromiseHelpers._createPromise((aResolverId) => {
      cpmm.sendAsyncMessage("SE:GetSEReaders", {
        resolverId: aResolverId,
        appId: this._window.document.nodePrincipal.appId
      });

    });
  },

  receiveMessage: function(aMessage) {
    let data = aMessage.json;
    let chromeObj = null;
    let contentObj = null;
    debug("receiveMessage(): " + aMessage.name  + " " + JSON.stringify(data));

    let resolver = PromiseHelpers.takePromiseResolver(data.resolverId);
    if (!resolver) {
      return;
    }

    switch (aMessage.name) {
      case "SE:GetSEReadersResolved":
        let readers = this._window.Array();
        if(data.secureelements[0] === 'uicc') {
          let chromeObj = new SEReader(this._window, 'uicc');
          let contentObj = this._window.SEReader._create(this._window, chromeObj);
          readers.push(contentObj);
        }
        // Update 'readers'
        SEStateHelper.addReaderObjs(readers);
        resolver.resolve(readers);
        break;
      case "SE:OpenSessionResolved":
        chromeObj = new SESession(this._window, SEStateHelper.getReaderObjByType(data.type), data.sessionId);
        contentObj = this._window.SESession._create(this._window, chromeObj);
        // Update the session obj
        SEStateHelper.addSessionObj(contentObj, data.sessionId, data.type);
        resolver.resolve(contentObj);
        break;
      case "SE:OpenChannelResolved":
        chromeObj = new SEChannel(this._window, 
                                  data.aid, 
                                  data.channelToken, 
                                  SEStateHelper.getSessionObjById(data.sessionId),
                                  data.sessionId);
        contentObj = this._window.SEChannel._create(this._window, chromeObj);
        // Update 'channel obj'
        SEStateHelper.addChannelObj(contentObj, data.sessionId, data.channelToken);
        resolver.resolve(contentObj);
        break;
      case "SE:TransmitAPDUResolved":
        let respApdu = data.respApdu;
        let channel = SEStateHelper.getChannelObjByToken(data.channelToken);
        chromeObj = new SEResponse(this._window,
                                   respApdu,
                                   channel);
        contentObj = this._window.SEResponse._create(this._window, chromeObj);
        resolver.resolve(contentObj);
        break;
      case "SE:CloseAllByReaderResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteReaderObjByType(data.type);
        resolver.resolve();
        break;
      case "SE:CloseAllBySessionResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteSessionObjById(data.sessionId);
        resolver.resolve();
        break;
      case "SE:CloseChannelResolved":
        // Clear the state in SEStateHelper obj
        SEStateHelper.deleteChannelObjByToken(data.sessionId, data.channelToken);
        resolver.resolve();
        break;
      case "SE:GetSEReadersRejected":
      case "SE:OpenSessionRejected":
        resolver.reject();
        break;
      case "SE:OpenChannelRejected":
      case "SE:CloseChannelRejected":
      case "SE:TransmitAPDURejected":
      case "SE:CloseAllByReaderRejected":
      case "SE:CloseAllBySessionRejected":
        debug("TBD: Handle Rejected scenarios " + aMessage.name);
        resolver.reject();
        break;
      case "SE:NotifySEStateChange":
        let reader = SEStateHelper.getReaderObjByType(data.type);
        if (reader)
          reader.isSEPresent = data.isPresent;
        break;
      default:
        debug("Could not find a handler for " + aMessage.name);
        resolver.reject();
        break;
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([SECommand,
                                                     SEResponse,
                                                     SEChannel,
                                                     SESession,
                                                     SEReader,
                                                     SEManager]);
