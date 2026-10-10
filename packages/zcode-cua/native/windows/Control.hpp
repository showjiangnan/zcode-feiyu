// Modified by ZCode Feiyu contributors (2026).
#pragma once
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include "vendor/json.hpp"
#include "InputTranslation.hpp"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <climits>
#include <cwctype>
#include <condition_variable>
#include <dwmapi.h>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <windows.h>
#include <ole2.h>
#include <uiautomation.h>
#include <vector>
#include <wrl/client.h>
#include <wtsapi32.h>
using Json = nlohmann::json;
using Microsoft::WRL::ComPtr;
constexpr ULONG_PTR InputTag = 0x5A434F4445;
struct Fault : std::runtime_error {
  std::string code;
  Json details;
  Fault(std::string c, std::string m, Json d = Json::object())
      : std::runtime_error(m), code(c), details(d) {}
};
inline void check(HRESULT hr, const char *operation) {
  if (FAILED(hr))
    throw Fault("native_error", operation, {{"hresult", hr}});
}
std::wstring wide(const std::string &value);
std::string utf8(const std::wstring &value);
std::string uniqueId();
std::string text(const Json &input, const char *key, size_t limit = 4096);
double number(const Json &input, const char *key, double fallback = 0);
bool interactiveDesktop();
bool nativeInputNeutral();
std::string processPath(DWORD pid);
std::string fileIdentity(const std::string &path);
std::string incarnation(DWORD pid);
DWORD integrityLevel(DWORD pid);
struct Target {
  HWND hwnd;
  DWORD pid;
  RECT bounds;
  std::string id;
  std::string title;
  Json json() const;
};
struct Node {
  ComPtr<IUIAutomationElement> element;
  std::string id;
  std::string role;
  std::string label;
  std::string value;
  Json row;
};
struct Observation {
  std::string id;
  Target target;
  std::map<std::string, Node> nodes;
  Json rows;
  std::string imageId;
  int width = 0;
  int height = 0;
  RECT imageBounds{};
};
struct Operation {
  std::string id;
  Json context;
  ULONGLONG deadline;
  Json authorizationGate = Json::object();
  Json application = Json::object();
  bool mutation = false;
  std::string key() const;
  void guard() const;
};
void checkNativeAuthorization(const Json &gate, const Json &application);
struct Raster {
  std::string data;
  int width;
  int height;
  RECT bounds;
  std::string mimeType;
};
Raster captureWindow(const Target &target, const Operation &operation,
                     bool preview, const Json &input);
bool captureSupported();
bool containsControlPreview(DWORD pid);
void pasteText(const std::string &text, const Target &target,
               const Operation &operation,
               const std::function<void(std::vector<INPUT>)> &send);
void writeReply(const std::string &id, const Json &result, bool ok = true);
void writeEvent(const Json &event);
extern std::atomic<bool> quitting;
extern std::mutex stateMutex;
extern std::set<std::string> cancelled;
extern std::set<std::string> stopped;
extern Json controlContext;
extern std::atomic<HWND> inputWindow;
extern std::atomic<bool> userInterrupted;
void installStopMonitor();
void stopMonitor();
bool hasNativeStopMonitor();
bool nativeStopDispatchPending();
void configureControlFeedback(const Json &);
void controlFeedbackPhase(const Target &, const Operation &, const std::string &);
void controlFeedbackPointer(const Target &, const Operation &, POINT, bool pressed = false);
void clearControlFeedback(const std::string &key = "", const std::string &targetId = "");
void pauseControlFeedback(const std::string &key);
void shutdownControlFeedback();
HWND physicalControlWindowAt(POINT);
extern std::atomic<bool> isolatedInput;
std::string windowGeneration(HWND window);
bool waitForSettled(const Operation &operation);
bool cleanupInput();
bool cleanupIsolatedInput();
UINT sendTrackedInput(const std::vector<INPUT> &events);
class DeviceLease {
  HANDLE handle = INVALID_HANDLE_VALUE;
  HANDLE openExclusive();
  void clearMarker();

public:
  ~DeviceLease();
  void acquire(bool requireNeutral = true);
  void release();
  void abandon();
  void acknowledge();
};
class Engine {
  ComPtr<IUIAutomation> automation;
  Json automationFailure = Json::object();
  DeviceLease device;
  std::string owner;
  std::map<std::string, Observation> observations;
  std::set<WORD> pressed;
  UINT acceptedSegments = 0;
  std::string wheelTarget;
  double wheelX = 0, wheelY = 0;

public:
  Engine();
  ~Engine();
  Json handle(const std::string &method, const Json &params,
              const Operation &op);
  Json descriptor(const Json &input);
  std::vector<Target> windows(const Json &input);
  Target target(const Json &input);
  Json observe(const Target &, const Json &, const Operation &, bool preview);
  Json action(const std::string &, const Target &, const Json &,
              const Operation &);
  void isolatedAction(const std::string &, const Target &, const Json &, Observation &, const Operation &);
  void acquire(const Operation &);
  void release(const std::string &key = "");
  void abandon();
  void qualify(const Operation &, const Json &, bool mutation);
  void verifyForeground(const Target &, const Operation &);
  void send(std::vector<INPUT>, const Target &, const Operation &);
  Observation &fresh(const Target &, const Json &, const Operation &);
  Node &element(Observation &, const Json &);
  POINT point(const Target &, const Observation &, const Json &);
  Json launch(const Json &, const Operation &);
  Json capabilities();
  POINT wheel(const Target &, const Json &);
  IUIAutomation *uia() {
    if (!automation) throw Fault("uia_unavailable", "UI Automation is unavailable", automationFailure);
    return automation.Get();
  }
};
