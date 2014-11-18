"use strict";

function debug(s) {
  dump("-*- FakeApi: " + s + "\n");
}

debug("Loading file.");

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/DOMRequestHelper.jsm");

XPCOMUtils.defineLazyServiceGetter(this, "appsService",
                                   "@mozilla.org/AppsService;1",
                                   "nsIAppsService");

XPCOMUtils.defineLazyServiceGetter(this, "cpmm",
                                   "@mozilla.org/childprocessmessagemanager;1",
                                   "nsISyncMessageSender");

function FakeApi() {
  debug("Constructor");
};

FakeApi.prototype = {
  __proto__: DOMRequestIpcHelper.prototype,
  _manifestURL: null,

  classID: Components.ID("{6ff2b290-2573-11e3-8224-0800200c9a77}"),
  contractID: "@mozilla.org/navigatorFake;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports,
                                         Ci.nsISupportsWeakReference,
                                         Ci.nsIObserver,
                                         Ci.nsIDOMGlobalPropertyInitializer]),

  init: function init(aWindow) {
    debug("Init.");

    // This allows us to use DOM helper to create promises.
    // It also gives as a useful .getPromiseResolverId(),
    // and of course dispatches messages to this component.
    this.initDOMRequestHelper(aWindow, ['ACEService:IsAccessAllowed:Return:OK',
                                        'ACEService:IsAccessAllowed:Return:KO',
					'ACEService:ReadRules:Return']);

    let principal = aWindow.document.nodePrincipal;
    this._manifestURL = appsService.getManifestURLByLocalId(principal.appId);
  },

  openLogicalChannel: function openLogicalChannel() {
    debug('Openinig logical channel for app ' + this._manifestURL);

    let promiseInit = (resolve, reject) => {
      let resolverId = this.getPromiseResolverId({ resolve: resolve,
                                                   reject: reject });

      cpmm.sendAsyncMessage("ACEService:IsAccessAllowed",
                            { requestId: resolverId,
                              manifestURL: this._manifestURL });
    };

    return this.createPromise(promiseInit);
  },

  readRules: function readRules() {
    debug("Reading rules");


    let promiseInit = (resolve, reject) => {
      let resolverId = this.getPromiseResolverId({ resolve: resolve,
                                                   reject: reject });

      cpmm.sendAsyncMessage("ACEService:ReadRules",
                            { requestId: resolverId,
                              manifestURL: this._manifestURL });
    };

    return this.createPromise(promiseInit);
  },

  receiveMessage: function receiveMessage(aMessage) {
    debug("receiveMessage(): " + aMessage.name);

    let json = aMessage.json;
    let request = this.getRequest(json.requestId);

    if (!request) {
      debug("No request stored! " + json.requestId);
      return;
    }

    switch (aMessage.name) {
      case "ACEService:IsAccessAllowed:Return:OK":
        request.resolve();
        break;

      case "ACEService:IsAccessAllowed:Return:KO":
        request.reject();
        break;

      case "ACEService:ReadRules:Return":
        request.resolve(aMessage.json.rules);
        break;

      default:
        debug("Wrong message: " + aMessage.name);
        break;
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([FakeApi]);
debug('File loaded.');
