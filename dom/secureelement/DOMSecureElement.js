/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2014, Deutsche Telekom, Inc. */

/* globals dump, Components, XPCOMUtils, DOMRequestIpcHelper, iccProvider,
   cpmm, Services */

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

function byte2hexString(uint8arr) {
  if (!uint8arr) {
    return "";
  }

  var hexStr = "";
  for (var i = 0; i < uint8arr.length; i++) {
    var hex = (uint8arr[i] & 0xff).toString(16);
    hex = (hex.length === 1) ? "0" + hex : hex;
    hexStr += hex;
  }
  return hexStr.toUpperCase();
}

function hexString2byte(str) {
  var a = [];
  for(var i = 0, len = str.length; i < len; i+=2) {
    a.push(parseInt(str.substr(i,2),16));
  }
  return new Uint8Array(a);
}


/*
 * Helper object to get / set 'SEReader' & 'SEChannel' objects
 */
let SEStateHelper = {
  _readerObjs: null,
  
  _sessionObjs: {},

  _channelObjs: {},

  addReaderObjs(readerObjs) {
    this._readerObjs = readerObjs;
  },
 
  getReaderObjByType(type) {
    if (type == 'uicc')
      return this._readerObjs[SE_TYPE_SIM];
    else if (type === 'eSE')
      return this._readerObjs[SE_TYPE_ESE];

    return null;
  },

  addSessionObj(sessionObj, sessionId) {
    this._sessionObjs[sessionId] = sessionObj;
  },

  getSessionObjById(sessionId) {
    return this._sessionObjs[sessionId];
  },

  addChannelObj(channelObj, channelToken) {
    this._channelObjs[channelToken] = channelObj;
  },

  getChannelObjByToken(channelToken) {
    return this._channelObjs[channelToken];
  }
};

function PromiseHelpersSubclass(win) {
   this._window = win;
}
PromiseHelpersSubclass.prototype = {
  _window: null,

  __proto__: DOMRequestIpcHelper.prototype,

  _createPromise: function(aCallback) {
    let self = this;
    return this.createPromise(function(aResolve, aReject) {
      let resolverId = self.getPromiseResolverId({
        resolve: aResolve,
        reject: aReject
      });
      // TBD: On some condition, say
      if (false) {
        self.removePromiseResolver(resolverId);
        reject('SEManager is not active.');
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
    this.data = hexString2byte(respApdu[2]);
  }
  this.sw1 = 0x00FF & respApdu[0];
  this.sw2 = 0x00FF & respApdu[1];
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
    // TBD: Verify the sacntity of 'pdu'
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
   
    let apdu = {
      cla: command.cla,
      command: command.ins,
      p1: command.p1,
      p2: command.p2,
      path: null,
      Lc: 0x02,
      data: command.data,
      data2: null
    };

    debug("APDU to be sent: " + JSON.stringify(apdu));
    return new this._window.Promise((resolve, reject) => {
      let request = iccProvider.iccExchangeAPDU(0, this._window , this._channelToken,  apdu);
      request.onsuccess = () => {
        debug("Got response from SIM: " +  JSON.stringify(request.result));
        let chromeObj = new SEResponse(this._window, request.result, this);
        let contentObj = this._window.SEResponse._create(this._window, chromeObj);

        debug("resolving promise with object" + JSON.stringify(contentObj));
        resolve(contentObj);
      };

      request.onerror = () => {
        debug("exchange apdu failed");
        reject();
      };
    });
  },

  close: function() {
    if (this.isClosed) {
      throw new Error("Session Already Closed!");
    }

    return new this._window.Promise((resolve, reject) => {
      let request = iccProvider.iccCloseChannel(0, this._window, this._channelToken);
      request.onsuccess = () => {
        this.isClosed = true;
        this.session.removeClosedChannel(this);
        debug("closing channel");
        resolve();
      };
      request.onerror = () => {
        debug("channel close failed");
        reject();
      };
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
  this._openedChannels  = [];
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

    debug("waivin xrays");
    this._aid = Cu.waiveXrays(aid);
    let aidStr = byte2hexString(this._aid);
    debug("opening channel to aid: " + aidStr);
    return new this._window.Promise((resolve, reject) => {
      let request = iccProvider.iccOpenChannel(0, this._window , aidStr);
      request.onsuccess = () => {
        debug("Got open channel success");
        debug("request object: " + JSON.stringify(request));
        // setting channelToken to channel id
        let chromeObj = new SEChannel(this._window, aidStr, request.result , this, this._sessionId);
        let contentObj = this._window.SEChannel._create(this._window, chromeObj);
        this._openedChannels.push(chromeObj);
        // Update "channel obj"
        SEStateHelper.addChannelObj(contentObj, request.result);
        debug("resolving promise with channel object");
        resolve(contentObj);
      };

      request.onerror = () => {
        debug("openLogicalChannel onerror, rejecting promise");
        reject();
      };
    });
  },

  closeAll: function() {
    let promises = this._openedChannels.map((channel) => channel.close());

    return this._window.Promise.all(promises)
            .then(() =>  { 
              debug("All channels closed");
              this.isClosed = true; 
              return this._window.Promise.resolve(); 
            })
            .catch(() => { 
              debug("Failed to close all channels");
              this._window.Promise.reject();
            });
  },

  removeClosedChannel: function(channel) {
    debug("removing closed channel from session._openedChannels");
    let idx = this._openedChannels.indexOf(channel);
    if (idx === -1) {
      debug("channel not in openedChannels array");
      return;
    }

    this._openedChannels.splice(idx, 1);
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
}

SEReader.prototype = {
  _window: null,

  classID: Components.ID("{1c7bdba3-cd35-4f8b-a546-55b3232457d5}"),
  contractID: "@mozilla.org/secureelement/SEReader;1",
  QueryInterface: XPCOMUtils.generateQI([]),

  openSession: function() {
    let self = this;
    return PromiseHelpers._createPromise(function(aResolverId) {
      cpmm.sendAsyncMessage("SE:OpenSession", {
        resolverId: aResolverId,
        type: self.type,
        appId: self._window.document.nodePrincipal.appId
      });
    });
  },

  closeAll: function() {
    return PromiseHelpers._createPromise(function(aResolverId) {
      cpmm.sendAsyncMessage("SE:CloseAllByReader", {
        resolverId: aResolverId
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
                      "SE:CloseAllBySessionRejected"];

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
    let self = this;
    return PromiseHelpers._createPromise(function(aResolverId) {
      cpmm.sendAsyncMessage("SE:GetSEReaders", {
        resolverId: aResolverId,
        appId: self._window.document.nodePrincipal.appId
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
        SEStateHelper.addSessionObj(contentObj, data.sessionId);
        resolver.resolve(contentObj);
        break;
      case "SE:OpenChannelResolved":
        chromeObj = new SEChannel(this._window, 
                                  data.aid, 
                                  data.channelToken, 
                                  SEStateHelper.getSessionObjById(data.sessionId),
                                  data.sessionId);
        contentObj = this._window.SEChannel._create(this._window, chromeObj);
        // Update "channel obj"
        SEStateHelper.addChannelObj(contentObj, data.channelToken);
        resolver.resolve(contentObj);
        break;
      case "SE:TransmitAPDUResolved":
        let respApdu = data.respApdu;
        chromeObj = new SEResponse(this._window,
                                   respApdu,
                                   SEStateHelper.getChannelObjByToken(data.channelToken));
        contentObj = this._window.SEResponse._create(this._window, chromeObj);
        resolver.resolve(contentObj);
        break;
      case "SE:CloseAllByReaderResolved":
      case "SE:CloseAllBySessionResolved":
      case "SE:CloseChannelResolved":
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
