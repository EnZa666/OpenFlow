$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class OpenFlowUnmute {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int Unused(int a, uint b, out IntPtr c);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr p, out IntPtr instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
  }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int R0(IntPtr a);
    [PreserveSig] int R1(IntPtr a);
    [PreserveSig] int GetChannelCount(out uint n);
    [PreserveSig] int S2(float a, ref Guid b);
    [PreserveSig] int S3(float a, ref Guid b);
    [PreserveSig] int G4(out float a);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int S6(uint a, float b, ref Guid c);
    [PreserveSig] int S7(uint a, float b, ref Guid c);
    [PreserveSig] int G8(uint a, out float b);
    [PreserveSig] int G9(uint a, out float b);
    [PreserveSig] int SetMute(int mute, ref Guid ctx);
    [PreserveSig] int GetMute(out int mute);
  }
  public static void Run() {
    var thread = new Thread(() => {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      if (enumerator.GetDefaultAudioEndpoint(1, 0, out device) != 0 || device == null) return;
      Guid volId = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
      IntPtr raw;
      if (device.Activate(ref volId, 23, IntPtr.Zero, out raw) != 0 || raw == IntPtr.Zero) return;
      var volume = (IAudioEndpointVolume)Marshal.GetObjectForIUnknown(raw);
      int mute;
      if (volume.GetMute(out mute) != 0 || mute == 0) return;
      Guid ctx = Guid.NewGuid();
      volume.SetMute(0, ref ctx);
    });
    thread.SetApartmentState(ApartmentState.MTA);
    thread.Start();
    thread.Join();
  }
}
"@
[OpenFlowUnmute]::Run()
