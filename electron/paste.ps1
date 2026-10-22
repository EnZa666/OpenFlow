$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

public static class OpenFlowPaste {
  private const uint GA_ROOT = 2;

  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr hWndNewOwner);
  [DllImport("user32.dll")] public static extern bool EmptyClipboard();
  [DllImport("user32.dll")] public static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
  [DllImport("user32.dll")] public static extern bool CloseClipboard();
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr hMem);
  [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr hMem);
  [DllImport("kernel32.dll")] public static extern IntPtr GlobalFree(IntPtr hMem);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Explicit, Size = 40)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public ushort wVk;
    [FieldOffset(10)] public ushort wScan;
    [FieldOffset(12)] public uint dwFlags;
    [FieldOffset(16)] public uint time;
    [FieldOffset(24)] public IntPtr dwExtraInfo;
  }

  private static void ReleaseModifiers() {
    ushort[] keys = new ushort[] { 0x11, 0xA2, 0xA3, 0x5B, 0x5C, 0x12, 0xA4, 0xA5, 0x10, 0xA0, 0xA1 };
    INPUT[] inputs = new INPUT[keys.Length];
    for (int i = 0; i < keys.Length; i++) { inputs[i].type = 1; inputs[i].wVk = keys[i]; inputs[i].dwFlags = 2; }
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  private static bool IsShell(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return true;
    StringBuilder name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    string value = name.ToString();
    return value == "Progman" || value == "WorkerW" || value == "Shell_TrayWnd" || value == "Shell_SecondaryTrayWnd";
  }

  private static bool ReadOnly(AutomationElement element) {
    object pattern;
    if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return false;
    return ((ValuePattern)pattern).Current.IsReadOnly;
  }

  private static bool IsEditable(AutomationElement start) {
    AutomationElement current = start;
    for (int i = 0; i < 6 && current != null; i++) {
      ControlType type = current.Current.ControlType;
      if (type == ControlType.Edit || type == ControlType.Document || type == ControlType.ComboBox) return !ReadOnly(current);
      object customPattern;
      if (type == ControlType.Custom && current.TryGetCurrentPattern(ValuePattern.Pattern, out customPattern)) return !ReadOnly(current);
      if (type == ControlType.Window) break;
      current = TreeWalker.ControlViewWalker.GetParent(current);
    }
    return false;
  }

  private static bool HasCaret(IntPtr hwnd) {
    uint thread = GetWindowThreadProcessId(hwnd, IntPtr.Zero);
    if (thread == 0) return false;
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(thread, ref info)) return false;
    return info.hwndCaret != IntPtr.Zero;
  }

  private static bool CanType() {
    IntPtr foreground = GetForegroundWindow();
    if (IsShell(foreground)) return false;
    if (HasCaret(foreground)) return true;
    try {
      AutomationElement element = AutomationElement.FocusedElement;
      return element != null && IsEditable(element);
    } catch { return false; }
  }

  private static void Focus(long raw) {
    if (raw == 0) return;
    IntPtr target = new IntPtr(raw);
    if (IsShell(target) || GetForegroundWindow() == target) return;
    uint me = GetCurrentThreadId();
    IntPtr current = GetForegroundWindow();
    uint from = GetWindowThreadProcessId(current, IntPtr.Zero);
    uint to = GetWindowThreadProcessId(target, IntPtr.Zero);
    bool attachedFrom = from != 0 && AttachThreadInput(me, from, true);
    bool attachedTo = to != 0 && AttachThreadInput(me, to, true);
    SetForegroundWindow(target);
    BringWindowToTop(target);
    if (attachedTo) AttachThreadInput(me, to, false);
    if (attachedFrom) AttachThreadInput(me, from, false);
    Thread.Sleep(40);
  }

  private static bool TypeText(string text) {
    List<INPUT> batch = new List<INPUT>();
    int size = Marshal.SizeOf(typeof(INPUT));
    for (int index = 0; index < text.Length; index++) {
      char ch = text[index];
      if (ch == '\r') continue;
      INPUT down = new INPUT();
      INPUT up = new INPUT();
      down.type = 1;
      up.type = 1;
      if (ch == '\n') { down.wVk = 0x0D; up.wVk = 0x0D; up.dwFlags = 2; }
      else { down.wScan = ch; up.wScan = ch; down.dwFlags = 4; up.dwFlags = 6; }
      batch.Add(down);
      batch.Add(up);
      if (batch.Count < 40 && index < text.Length - 1) continue;
      INPUT[] inputs = batch.ToArray();
      if (SendInput((uint)inputs.Length, inputs, size) != inputs.Length) return false;
      batch.Clear();
    }
    return true;
  }

  private static void Log(string line) {
    try {
      string path = Environment.GetEnvironmentVariable("OPENFLOW_LOG");
      if (!string.IsNullOrWhiteSpace(path)) File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff ") + "fallback " + line + Environment.NewLine);
    } catch { }
  }

  private static bool SetClipboardText(string text) {
    if (!OpenClipboard(IntPtr.Zero)) return false;
    IntPtr memory = IntPtr.Zero;
    try {
      EmptyClipboard();
      memory = GlobalAlloc(0x0002, (UIntPtr)((text.Length + 1) * 2));
      if (memory == IntPtr.Zero) return false;
      IntPtr locked = GlobalLock(memory);
      if (text.Length > 0) Marshal.Copy(text.ToCharArray(), 0, locked, text.Length);
      Marshal.WriteInt16(locked, text.Length * 2, 0);
      GlobalUnlock(memory);
      if (SetClipboardData(13, memory) == IntPtr.Zero) return false;
      memory = IntPtr.Zero;
      return true;
    } finally {
      CloseClipboard();
      if (memory != IntPtr.Zero) GlobalFree(memory);
    }
  }

  public static bool TryPaste(long raw, string text) {
    try {
      if (string.IsNullOrEmpty(text)) return false;
      ReleaseModifiers();
      Thread.Sleep(60);
      IntPtr wanted = raw == 0 ? IntPtr.Zero : new IntPtr(raw);
      if (wanted != IntPtr.Zero && !IsShell(wanted)) Focus(raw);
      IntPtr foreground = GetForegroundWindow();
      Log("hwnd=" + raw + " fg=" + foreground.ToInt64());
      if (IsShell(foreground)) return false;
      if (!SetClipboardText(text)) return false;
      INPUT[] inputs = new INPUT[4];
      ushort[] keys = new ushort[] { 0x11, 0x56, 0x56, 0x11 };
      uint[] flags = new uint[] { 0, 0, 2, 2 };
      for (int i = 0; i < inputs.Length; i++) { inputs[i].type = 1; inputs[i].wVk = keys[i]; inputs[i].dwFlags = flags[i]; }
      uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
      Log("ctrlv sent=" + sent);
      return sent == inputs.Length;
    } catch { return false; }
  }
}
"@
$raw = 0L
[long]::TryParse($env:OPENFLOW_PASTE_HWND, [ref]$raw) | Out-Null
$text = ""
if ($env:OPENFLOW_PASTE_B64) {
  try { $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENFLOW_PASTE_B64)) } catch { $text = "" }
}
if ([OpenFlowPaste]::TryPaste($raw, $text)) { Write-Output "ok" } else { Write-Output "miss" }
