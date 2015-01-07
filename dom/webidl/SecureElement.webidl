/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

 /* Copyright © 2014 Deutsche Telekom, Inc. */

enum SEType {
  "uicc",
  "eSE"
};

enum SEError {
  "SESecurityError",            // Requested operation does not match the access control rules of the application.
  "SEIoError",                  // I/O Error while communicating with the secure element.
  "SEBadStateError",            // Error occuring as a result of bad state.
  "SEInvalidChannelError",      // Opening a channel failed because no channel is available.
  "SEInvalidApplicationError",  // The requested application was not found on the secure element.
  "SEGenericError"              // Generic failures.
};

enum SEChannelType {
  "basic",
  "logical"
};

[CheckPermissions="secureelement-manage",
 AvailableIn="PrivilegedApps",
 JSImplementation="@mozilla.org/secureelement/reader;1"]
interface SEReader {

  // 'true' if a secure element is present
  readonly attribute boolean isSEPresent;

  // Type of SecureElement
  readonly attribute SEType type;

  /**
   * Opens a session with the Secure Element.
   * Note that a reader may have several opened sessions.
   *
   * @return If the operation is successful the promise is resolved with an instance of SESession.
   */
  [Throws]
  Promise<SESession> openSession();

  /**
   * Closes all sessions associated with this Reader and its associated channels.
   *
   */
  [Throws]
  Promise<void> closeAll();
};

[CheckPermissions="secureelement-manage",
 AvailableIn="PrivilegedApps",
 JSImplementation="@mozilla.org/secureelement/session;1"]
interface SESession {

  // 'reader' that provides this session
  readonly attribute SEReader reader;

  // Status of current session
  readonly attribute boolean isClosed;

  /**
   * Opens a communication logical channel to an application on Secure Element identified by the AID.
   * The 'aid' can be null for some secure elements.
   *
   * @param aid
   *     Application Identifier of the Card Applet on the secure element.
   *     If the 'aid' is null :
   *       For secure element 'eSE', the default applet is selected.
   *       For secure element 'uicc', the request will be immediately rejected.
   *     Length of 'aid should be between 5 and 16.
   *
   * @return If the operation is successful the promise is resolved with an instance of SEChannel.
   */
  [Throws]
  Promise<SEChannel> openLogicalChannel(Uint8Array? aid);

  /**
   * Close all active channels associated with this session.
   *
   */
  [Throws]
  Promise<void> closeAll();
};

[CheckPermissions="secureelement-manage",
 AvailableIn="PrivilegedApps",
 JSImplementation="@mozilla.org/secureelement/channel;1"]
interface SEChannel {

  // 'session' obj this channel is bound to
  readonly attribute SESession session;

  // response to openBasicChannel / openLogicalChannel operation
  [Constant, Cached] readonly  attribute Uint8Array? openResponse;

  // Status of channel
  readonly attribute boolean isClosed;

  // Type of channel
  readonly attribute SEChannelType type;

  /**
   * Transmits the APDU command to the secure element. This is an atomic operation that transmits
   * an APDU command (as per ISO7816-4) to the secure element (UICC / eSE). Upon receiving response
   * to the transmit apdu command, it is propogated to the applications using SEResponse object.
   *
   * @param command
   *     SECommand to be sent to secure element
   *
   * @return If success, the promise is resolved with the new created
   * SEResponse object. Otherwise, rejected with the error of type 'SEError'.
   */
  [Throws]
  Promise<SEResponse> transmit(SECommand command);

  /**
   * Closes the active channel.
   *
   */
  [Throws]
  Promise<void> close();
};


// Interface that represents an APDU command to be sent to a secure element.
[CheckPermissions="secureelement-manage",
 AvailableIn="PrivilegedApps",
 JSImplementation="@mozilla.org/secureelement/command;1",
 Constructor(octet cla, octet ins, octet p1, octet p2, optional sequence<octet>? data = null, optional short le= -1)]
interface SECommand {

  attribute octet                           cla;    // 1 Byte  : Class Byte
  attribute octet                           ins;    // 1 Byte  : Instruction Byte
  attribute octet                           p1;     // 1 Byte  : First Octet of Parameters Byte
  attribute octet                           p2;     // 1 Byte  : Second Octet of Parameters Byte
  [Cached, Pure] attribute sequence<octet>? data;   // Sequence of octets
  attribute short                           le;     // The length of the expected
                                                    // response data or -1 if none is expected
};

[CheckPermissions="secureelement-manage",
 AvailableIn="PrivilegedApps",
 JSImplementation="@mozilla.org/secureelement/response;1"]
interface SEResponse {
   // Response received on this 'channel' object.
   readonly attribute SEChannel channel;

  // First octet of response's status word
  readonly attribute octet        sw1;

  // Second octet of response's status word
  readonly attribute octet        sw2;

  // The response's data field bytes
  [Cached, Pure] readonly attribute sequence<octet>?  data;

};

