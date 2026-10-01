#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <errno.h>
#import <fcntl.h>
#import <sys/file.h>
#import <unistd.h>

@interface SmithCompanionDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) NSPanel *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSURL *bridgeURL;
@property(nonatomic) BOOL closingBridge;
@property(nonatomic) int instanceLockFile;
@end

@implementation SmithCompanionDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSRect frame = NSMakeRect(160, 120, 1040, 720);
  self.window = [[NSPanel alloc] initWithContentRect:frame
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable | NSWindowStyleMaskUtilityWindow)
    backing:NSBackingStoreBuffered defer:NO];
  self.window.title = @"Live Smith";
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  self.window.floatingPanel = YES;
  self.window.hidesOnDeactivate = NO;
  // Apple documents canJoinAllApplications for floating windows that join other
  // apps' full-screen spaces. fullScreenAuxiliary is the separate full-screen
  // override that displays an auxiliary window in that space. Do not use
  // canJoinAllSpaces: this Companion should follow Ableton's active space.
  self.window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllApplications |
    NSWindowCollectionBehaviorFullScreenAuxiliary;
  self.window.level = NSFloatingWindowLevel;

  WKUserContentController *controller = [[WKUserContentController alloc] init];
  [controller addScriptMessageHandler:self name:@"live"];
  WKUserScript *companionPresentation = [[WKUserScript alloc] initWithSource:@"(() => { const button = document.getElementById('closeButton'); if (!button) return; button.setAttribute('title', 'End Smith Session'); button.setAttribute('aria-label', 'End Smith Session'); button.textContent = 'End Session'; button.style.width = 'auto'; button.style.padding = '0 12px'; })();" injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:YES];
  [controller addUserScript:companionPresentation];
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  configuration.userContentController = controller;
  configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
  self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:configuration];
  self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  self.webView.navigationDelegate = self;
  self.window.contentView = self.webView;
  [self.webView loadRequest:[NSURLRequest requestWithURL:self.bridgeURL]];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self.window makeFirstResponder:self.webView];
}

- (BOOL)windowShouldClose:(id)sender {
  [self.window orderOut:nil];
  return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [self.window makeFirstResponder:self.webView];
  return NO;
}

- (void)windowDidBecomeKey:(NSNotification *)notification {
  [self.window makeFirstResponder:self.webView];
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  return NSTerminateNow;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  if (self.instanceLockFile >= 0) {
    close(self.instanceLockFile);
    self.instanceLockFile = -1;
  }
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (![message.name isEqualToString:@"live"] || ![message.body isKindOfClass:[NSDictionary class]]) return;
  NSDictionary *body = (NSDictionary *)message.body;
  if (![body[@"method"] isEqualToString:@"close_and_send"] || self.closingBridge) return;
  self.closingBridge = YES;
  [self.webView evaluateJavaScript:@"fetch('/close',{method:'POST',credentials:'same-origin',keepalive:true}).then(response=>response.ok).catch(()=>false)" completionHandler:^(id result, NSError *error) {
    if (error != nil || ![result isKindOfClass:[NSNumber class]] || ![(NSNumber *)result boolValue]) {
      self.closingBridge = NO;
      return;
    }
    self.closingBridge = NO;
    [self.window orderOut:nil];
  }];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  if (error.code != NSURLErrorCancelled) [NSApp terminate:nil];
}
@end

static SmithCompanionDelegate *companion;

static int acquireInstanceLock(void) {
  NSURL *supportDirectory = [[NSFileManager defaultManager] URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:nil];
  if (supportDirectory == nil) return -1;
  NSURL *liveSmithDirectory = [supportDirectory URLByAppendingPathComponent:@"Live Smith" isDirectory:YES];
  if (![[NSFileManager defaultManager] createDirectoryAtURL:liveSmithDirectory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions: @0700} error:nil]) return -1;
  NSURL *lockURL = [liveSmithDirectory URLByAppendingPathComponent:@"Smith Companion.lock" isDirectory:NO];
  int descriptor = open(lockURL.fileSystemRepresentation, O_CREAT | O_RDWR, 0600);
  if (descriptor < 0) return -1;
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    int lockError = errno;
    close(descriptor);
    return (lockError == EWOULDBLOCK || lockError == EAGAIN) ? -2 : -1;
  }
  return descriptor;
}

static void installApplicationMenu(void) {
  NSMenu *menuBar = [[NSMenu alloc] init];
  NSMenuItem *applicationMenuItem = [[NSMenuItem alloc] init];
  [menuBar addItem:applicationMenuItem];
  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Smith Companion"];
  [applicationMenu addItemWithTitle:@"Quit Smith Companion" action:@selector(terminate:) keyEquivalent:@"q"];
  applicationMenuItem.submenu = applicationMenu;
  NSApp.mainMenu = menuBar;
}

static void activateExistingCompanion(void) {
  NSString *identifier = [[NSBundle mainBundle] bundleIdentifier];
  for (NSRunningApplication *application in [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier]) {
    if (application.processIdentifier != getpid() && !application.terminated) {
      [application activateWithOptions:NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps];
      return;
    }
  }
}

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    if (argc != 2) return 64;
    NSString *value = [NSString stringWithUTF8String:argv[1]];
    NSURLComponents *components = [NSURLComponents componentsWithString:value];
    if (!components || ![components.scheme isEqualToString:@"http"] || ![components.host isEqualToString:@"127.0.0.1"] ||
        components.port == nil || ![components.path isEqualToString:@"/chat"] || components.queryItems.count != 1 ||
        ![components.queryItems[0].name isEqualToString:@"launch"]) return 64;
    int instanceLockFile = acquireInstanceLock();
    if (instanceLockFile == -2) {
      activateExistingCompanion();
      return 75;
    }
    if (instanceLockFile < 0) return 70;
    [NSApplication sharedApplication];
    installApplicationMenu();
    companion = [[SmithCompanionDelegate alloc] init];
    companion.bridgeURL = components.URL;
    companion.instanceLockFile = instanceLockFile;
    NSApp.delegate = companion;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp run];
  }
  return 0;
}
