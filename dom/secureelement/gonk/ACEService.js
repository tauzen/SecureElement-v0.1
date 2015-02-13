/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2015, Deutsche Telekom, Inc. */

"use strict";

/* globals dump, Components, XPCOMUtils, ppmm, DOMApplicationRegistry,
   SEUtils */

const DEBUG = false;
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
    let decision = this.rules.filter(this._searchForRules.bind(this));

    if (!!decision.length &&
        decision[0].application === Ci.nsIAccessRulesManager.ALLOW_ALL) {
      return true;
    } else if (!!decision.length && Array.isArray(decision[0].application)) {
      return true;
    }

    return false;
  },

  _searchForRules: function _searchForRules(rule) {
    let appMatched, appletMatched;

    // GPD 4.2.3 A and 4.2.3 C
    if (Array.isArray(rule.application)) {
      appMatched = this._applicationMatches(rule.application);
    // GPD 4.2.3 B and 4.2.3 D
    } else {
      appMatched = [Ci.nsIAccessRulesManager.ALLOW_ALL,
                    Ci.nsIAccessRulesManager.DENY_ALL]
                    .indexOf(rule.application) !== -1;
    }

    // GPD 4.2.3 A and 4.2.3 B
    if (Array.isArray(rule.applet)) {
      appletMatched = SEUtils.arraysEqual(rule.applet, this.aid);
    // GPD 4.2.3 C and 4.2.3 D
    } else {
      appletMatched = rule.applet === Ci.nsIAccessRulesManager.ALL_APPLET;
    }

    return appMatched && appletMatched;
  },

  _applicationMatches: function _applicationMatches(appArray) {
    if (!Array.isArray(appArray)) {
      return false;
    }

    return !!(appArray.find((hash) => {
      return SEUtils.arraysEqual(hash, this.certHash);
    }));
  }
};

function ACEService() {
  this._rulesManager =
    Cc["@mozilla.org/secureelement/access-control/rules-manager/gp;1"]
    .getService(Ci.nsIAccessRulesManager);

  // don't initialise here for now since ACE is lazy loaded by SE
  // this._rulesManager.init().then(() => {
  //  debug("Rule Manager initialised");
  // });
}

ACEService.prototype = {
  _rulesManager: null,

  isAccessAllowed: function isAccessAllowed(localId, seType, aid) {
    let manifestURL = DOMApplicationRegistry.getManifestURLByLocalId(localId);
    if (!manifestURL) {
      return Promise.reject(new Error("Missing manifest for app: " + localId));
    }

    return new Promise((resolve, reject) => {
      debug("isAccessAllowed for " + manifestURL + " to " + aid);

      this._getDevCertHashForApp(manifestURL).then((certHash) => {
        if (!certHash) {
          debug("App " + manifestURL + " tried to access SE, but no developer" +
                " certificate present");
          return reject(Error("No developer certificate found."));
        }

        this._rulesManager.getAccessRules()
        .then((rules) => {
          let decision = new GPAccessDecision(rules,
            SEUtils.hexStringToByteArray(certHash), aid);

          resolve(decision.isAccessAllowed());
        });
      });
    });
  },

  _getDevCertHashForApp: function getDevCertHashForApp(manifestURL) {
    return DOMApplicationRegistry.getManifestFor(manifestURL)
    .then((manifest) => {
      DEBUG && debug("manifest retrieved: " + JSON.stringify(manifest));

      // TODO: Bug 973823
      //  - verify if app is signed by marketplace
      //  - retrieve the cert from the app
      //  - verify GUID signature
      //  - compute the hash of the cert and possibly store it for future use
      //    (right now we have the cert hash included in manifest file)
      //  - remove this once we have fixed all the todos
      return manifest.secure_element_sig || "";
    })
    .catch((error) => {
      debug("Not able to retrieve cert hash: " + error);
      return "";
    });
  },

  classID: Components.ID("{882a7463-2ca7-4d61-a89a-10eb6fd70478}"),
  contractID: "@mozilla.org/secureelement/access-control/ace;1",
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIAccessControlEnforcer])
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([ACEService]);

