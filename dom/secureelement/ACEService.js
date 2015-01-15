/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2015, Deutsche Telekom, Inc. */

"use strict";

/* globals dump, Components, XPCOMUtils, ppmm, DOMApplicationRegistry,
   SEUtils */

const DEBUG = true;
function debug(msg) {
  if (DEBUG) {
    dump("ACEservice: " + msg + "\n");
  }
}

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Promise.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "DOMApplicationRegistry",
                                  "resource://gre/modules/Webapps.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "SEUtils",
                                  "resource://gre/modules/SEUtils.jsm");

/**
  * Implements decision making algorithm as described in GPD specification,
  * mostly in 3.1, 3.2 and 4.2.3.
  *
  * Since GPAccessRulesManager does not support APDU filters, decision making
  * algorithm does not support that either (should be straightforward to add
  * later, though).
  */
function GPAccessDecision(rules, certHash, aid) {
  this.rules = rules;
  this.certHash = certHash;
  this.aid = aid;
}

GPAccessDecision.prototype = {
  isAccessAllowed: function isAccessAllowed() {
    let decision;

    // GPD 4.2.3 A
    decision = this.rules.filter(this._oneAppletOneApp.bind(this));
    if (decision.length === 1) {
      return true;
    }

    /*
     * Implements a following check (GPD 3.2.1):
     * "If a specific rule associates the hash of a device application with
     *   the AID of an SE application, then access to all the other device
     *   applications is denied unless a specific rule explicitly exists for
     *   this other device application."
     */
    let isAidBlocked = !!this.rules.find(this._oneAppletAnyApp.bind(this));
    if (isAidBlocked) {
      return false;
    }

    // GPD 4.2.3 B. No need to merge rules, because we do not implement
    // APDU filters for now.
    decision = this.rules.filter(this._oneAppletAllApps.bind(this));
    if (decision.length > 0) {
      return decision[0].application === "allowed-all" ? true : false;
    }

    // GPD 4.2.3 C
    decision = this.rules.filter(this._allAppletsOneApp.bind(this));
    if (decision.length === 1) {
      return true;
    }

    // GPD 4.2.3 D. No need to merge rules, because we do not implement
    // APDU filters for now.
    decision = this.rules.filter(this._allAppletsAllApps.bind(this));
    if (decision.length > 0) {
      return decision[0].application === "allowed-all" ? true : false;
    }

    return false;
  },

  _applicationMatches: function applicationMatches(appArray) {
    if (!Array.isArray(appArray)) {
      return false;
    }

    return !!(appArray.find((hash) => {
      return SEUtils.arraysEqual(hash, this.certHash);
    }));
  },

  _oneAppletAnyApp: function(rule) {
    return SEUtils.arraysEqual(rule.applet, this.aid) &&
           Array.isArray(rule.application);
  },

  _oneAppletOneApp: function(rule) {
    return SEUtils.arraysEqual(rule.applet, this.aid) &&
           this._applicationMatches(rule.application);
  },

  _oneAppletAllApps: function(rule) {
    let appMatches = rule.application === "allowed-all" ||
                     rule.application === "denied-all";
    return SEUtils.arraysEqual(rule.applet, this.aid) && appMatches;
  },

  _allAppletsOneApp: function(rule) {
    return rule.applet === "all" && this._applicationMatches(rule.application);
  },

  _allAppletsAllApps: function(rule) {
    let appMatches = rule.application === "allowed-all" ||
                     rule.application === "denied-all";
    return rule.applet === "all" && appMatches;
  }
};

function ACEService() {
  this._ruleManager = Cc["@mozilla.org/gp-access-rules-manager;1"]
                        .getService(Ci.nsIAccessRulesManager);
  this._ruleManager.init().then(() => {
    debug("Rule Manager initialised");
  });
}

ACEService.prototype = {
  _ruleManager: null,

  isAccessAllowed: function isAccessAllowed(localId, seName, aid) {
    let manifestURL = DOMApplicationRegistry.getManifestURLByLocalId(localId);
    if (manifestURL) {
      Promise.resolve(true);
    }

    let promiseInit = (resolve, reject) => {
      debug("isAccessAllowed for " + manifestURL + " to " + aid);

      let app = DOMApplicationRegistry.getAppByManifestURL(manifestURL);
      if (!app) {
        debug("No app found for " + manifestURL);
        return reject(Error("No app found for manifest " + manifestURL));
      }
      DEBUG && debug("App is: " + JSON.stringify(app));

      let certHash = this._getDevCertHashForApp(app);
      if (!certHash) {
        debug("App " + manifestURL + " tried to access SE, but no developer" +
              "certificate present");
        return reject(Error("No developer certificate found."));
      }

      this._ruleManager.getAccessRules()
      .then((rules) => {
        let decision = new GPAccessDecision(rules,
          SEUtils.hexStringToByteArray(certHash), aid);

        resolve(decision.isAccessAllowed());
      });
    };

    return new Promise(promiseInit);
  },

  /*
    TODO: This method will be implemented once it'll be decided in Bug 973823
          how the dev cert hash will be supplied by the developer.
  */
  _getDevCertHashForApp: function getDevCertHashForApp(app) {
    if (app.origin === "app://ace.gaiamobile.org") {
      debug("Setting test dev cert hash A683...2128");
      return "A683A44507D67C5A58D23BCF2DCBABED9AEC2128";
    } else if (app.origin === "app://ace2.gaiamobile.org") {
      debug("Setting test dev cert hash A683...2129");
      return "A683A44507D67C5A58D23BCF2DCBABED9AEC2129";
    } else if (app.dev_cert_hash) {
      debug("Setting dev cert hash to " + app.dev_cert_hash);
      return app.dev_cert_hash;
    } else {
      debug("Not setting test dev cert hash");
      return null;
    }
  },

  classID: Components.ID("{882a7463-2ca7-4d61-a89a-10eb6fd70478}"),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAccessControlEnforcer])
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([ACEService]);

