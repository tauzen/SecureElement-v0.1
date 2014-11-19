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

// Set to true to debug SecureElement (SE) stack
this.DEBUG_ALL = true;

// Set individually to debug specific layers
this.DEBUG_ACE = false || DEBUG_ALL;
this.DEBUG_SE = false || DEBUG_ALL;

// Maximun logical channels per session.
this.MAX_CHANNELS_ALLOWED_PER_SESSION = 4;

this.ERROR_SUCCESS = 0;
this.ERROR_GENERIC_FAILURE = 1;

this.SE_TYPE_UICC = 'uicc';
this.SE_TYPE_eSE = 'eSE';

// Allow this file to be imported via Components.utils.import().
this.EXPORTED_SYMBOLS = Object.keys(this);
