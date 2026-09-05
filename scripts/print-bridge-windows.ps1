# Invoked only by print-bridge.ts. No queue discovery, default printer, or policy bypass.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class DevFathomRawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DocInfo {
        [MarshalAs(UnmanagedType.LPWStr)] public string Name;
        [MarshalAs(UnmanagedType.LPWStr)] public string Output;
        [MarshalAs(UnmanagedType.LPWStr)] public string DataType;
    }
    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool OpenPrinter(string name, out IntPtr printer, IntPtr defaults);
    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint StartDocPrinter(IntPtr printer, uint level, ref DocInfo info);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool StartPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool WritePrinter(IntPtr printer, byte[] bytes, uint count, out uint written);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndPagePrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool EndDocPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool AbortPrinter(IntPtr printer);
    [DllImport("winspool.drv", SetLastError = true)]
    private static extern bool ClosePrinter(IntPtr printer);

    public static void Send(string queue, byte[] bytes) {
        if (String.IsNullOrWhiteSpace(queue) || queue.Length > 128 || queue.IndexOfAny(new char[] {'\\', '/', '\r', '\n', '\0'}) >= 0 || bytes.Length == 0 || bytes.Length > 1048576)
            throw new ArgumentException("Invalid local RAW job.");
        IntPtr printer;
        if (!OpenPrinter(queue, out printer, IntPtr.Zero)) throw new Win32Exception();
        bool started = false;
        bool completed = false;
        try {
            var info = new DocInfo { Name = "DevFathom receipt", Output = null, DataType = "RAW" };
            if (StartDocPrinter(printer, 1, ref info) == 0) throw new Win32Exception();
            started = true;
            if (!StartPagePrinter(printer)) throw new Win32Exception();
            uint written;
            if (!WritePrinter(printer, bytes, (uint)bytes.Length, out written) || written != bytes.Length)
                throw new InvalidOperationException("Incomplete RAW write.");
            if (!EndPagePrinter(printer)) throw new Win32Exception();
            if (!EndDocPrinter(printer)) throw new Win32Exception();
            completed = true;
        } finally {
            if (started && !completed) AbortPrinter(printer);
            ClosePrinter(printer);
        }
    }
}
'@
    $encoded = [Console]::In.ReadToEnd()
    if ($encoded.Length -gt 1398104) { throw 'Oversized receipt.' }
    [DevFathomRawPrinter]::Send($env:DEVFATHOM_PRINT_QUEUE, [Convert]::FromBase64String($encoded))
    exit 0
} catch {
    # Never expose queue names, payloads, environment values, or native exception text.
    [Console]::Error.WriteLine('RAW queue submission failed; inspect queue permissions and policy. Delivery may be partial.')
    exit 1
}
