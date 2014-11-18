[NoInterfaceObject,
 JSImplementation="@mozilla.org/navigatorFake;1",
 NavigatorProperty="mozFake"]
interface FakeApi {
   Promise<any> openLogicalChannel();
   Promise<any> readRules();
};
