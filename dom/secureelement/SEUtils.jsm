/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Copyright © 2014, Deutsche Telekom, Inc. */

"use strict";

this.SEUtils = {
  byteArrayToHexString: function se_byteArrayToHexString(array) {
    let hexStr = "";

    let len = array ? array.length : 0;
    for (let i = 0; i < len; i++) {
      let hex = (array[i] & 0xff).toString(16);
      hex = (hex.length === 1) ? "0" + hex : hex;
      hexStr += hex;
    }

    return hexStr.toUpperCase();
  },

  hexStringToByteArray: function se_hexStringToByteArray(hexStr) {
    let array = [];

    let len = hexStr ? hexStr.length : 0;
    for(let i = 0; i < len; i+=2) {
      array.push(parseInt(hexStr.substr(i, 2), 16));
    }
    
    return array;
  },
};

this.EXPORTED_SYMBOLS = ["SEUtils"];