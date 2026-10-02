// Windows PowerShell 5.1 loads this dependency-free helper with Add-Type.
// DXGI DuplicateOutput1 keeps scRGB FP16 pixels until conversion to the OCR bitmap.
// COM slots follow dxgi1_5.h and d3d11.h; every acquired interface/frame is released.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public sealed class AmoCaptureFrame : IDisposable {
    public Bitmap Bitmap;
    public string Backend, PixelFormat, ToneMap, Warning;
    public bool? Hdr;
    public void Dispose() { if (Bitmap != null) Bitmap.Dispose(); }
}

public static class AmoDisplayCapture {
    const int Float16 = 10, Bgra8 = 87;
    static readonly byte[] HdrLut = MakeHdrLut();

    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct OutputDesc {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        public Rect Bounds; public int Attached, Rotation; public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct OutputDesc1 {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        public Rect Bounds; public int Attached, Rotation; public IntPtr Monitor;
        public uint BitsPerColor; public int ColorSpace;
        public float RedX, RedY, GreenX, GreenY, BlueX, BlueY, WhiteX, WhiteY;
        public float MinLuminance, MaxLuminance, MaxFullFrameLuminance;
    }
    [StructLayout(LayoutKind.Sequential)] struct TextureDesc {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality;
        public uint Usage, BindFlags, CpuAccessFlags, MiscFlags;
    }
    [StructLayout(LayoutKind.Sequential)] struct FrameInfo {
        public long LastPresent, LastMouse;
        public uint Accumulated; public int Coalesced, Protected, PointerX, PointerY, PointerVisible;
        public uint MetadataSize, PointerShapeSize;
    }
    [StructLayout(LayoutKind.Sequential)] struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driver, IntPtr software,
        uint flags, IntPtr levels, uint levelCount, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumChild(IntPtr self, uint index, out IntPtr child);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetOutputDesc(IntPtr self, out OutputDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetOutputDesc1(IntPtr self, out OutputDesc1 desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Duplicate(IntPtr self, IntPtr device, uint flags,
        uint count, [In] int[] formats, out IntPtr duplication);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Acquire(IntPtr self, uint timeout, out FrameInfo info, out IntPtr resource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseFrame(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void GetTextureDesc(IntPtr self, out TextureDesc desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self, ref TextureDesc desc, IntPtr data, out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyResource(IntPtr self, IntPtr target, IntPtr source);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapResource(IntPtr self, IntPtr resource, uint subresource, uint type, uint flags, out Mapped mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapResource(IntPtr self, IntPtr resource, uint subresource);

    static T Method<T>(IntPtr obj, int slot) where T : class {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), typeof(T)) as T;
    }
    static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
    static void Release(ref IntPtr obj) { if (obj != IntPtr.Zero) { Marshal.Release(obj); obj = IntPtr.Zero; } }
    static IntPtr Query(IntPtr obj, string id) {
        Guid guid = new Guid(id); IntPtr result;
        Check(Marshal.QueryInterface(obj, ref guid, out result)); return result;
    }

    // Half-float scRGB is linear, including values above SDR white (1.0 = 80 nits).
    // Reinhard + sRGB encoding retains highlight contrast instead of clipping at 1.0.
    public static byte ToneMapHalf(ushort half) { return HdrLut[half]; }
    static byte[] MakeHdrLut() {
        byte[] lut = new byte[65536];
        for (int bits = 0; bits < lut.Length; bits++) {
            int exponent = (bits >> 10) & 31, mantissa = bits & 1023;
            if ((bits & 32768) != 0 || (exponent == 31 && mantissa != 0)) continue;
            double linear = exponent == 0 ? mantissa * Math.Pow(2, -24)
                : exponent == 31 ? double.PositiveInfinity : (1 + mantissa / 1024.0) * Math.Pow(2, exponent - 15);
            double mapped = double.IsPositiveInfinity(linear) ? 1 : linear / (1 + linear);
            double srgb = mapped <= 0.0031308 ? mapped * 12.92 : 1.055 * Math.Pow(mapped, 1 / 2.4) - 0.055;
            lut[bits] = (byte)Math.Round(Math.Max(0, Math.Min(1, srgb)) * 255);
        }
        return lut;
    }

    // Public to allow native regression tests using padded, synthetic SDR/HDR rows.
    public static byte[] ConvertRow(byte[] row, int x, int width, int format) {
        int bpp = format == Float16 ? 8 : format == Bgra8 ? 4 : 0;
        if (bpp == 0 || x < 0 || width <= 0 || (long)(x + width) * bpp > row.Length)
            throw new ArgumentException("Invalid capture row/format");
        byte[] result = new byte[width * 4];
        for (int i = 0; i < width; i++) {
            int src = (x + i) * bpp, dst = i * 4;
            if (format == Float16) {
                result[dst] = HdrLut[row[src + 4] | (row[src + 5] << 8)];
                result[dst + 1] = HdrLut[row[src + 2] | (row[src + 3] << 8)];
                result[dst + 2] = HdrLut[row[src] | (row[src + 1] << 8)];
            } else {
                result[dst] = row[src]; result[dst + 1] = row[src + 1]; result[dst + 2] = row[src + 2];
            }
            result[dst + 3] = 255;
        }
        return result;
    }

    public static AmoCaptureFrame Capture(int x, int y, int width, int height) {
        if (width <= 0 || height <= 0) throw new ArgumentException("Invalid capture dimensions");
        // Reopen on each request: display moves, HDR toggles and lost duplication sessions
        // cannot leave us serving an old frame. The OCR engine itself remains persistent.
        try { return CaptureDxgi(x, y, width, height); }
        catch (Exception e) {
            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            try {
                using (Graphics g = Graphics.FromImage(bitmap)) g.CopyFromScreen(x, y, 0, 0, bitmap.Size);
                return new AmoCaptureFrame { Bitmap = bitmap, Backend = "gdi", PixelFormat = "B8G8R8A8_UNORM",
                    Hdr = null, ToneMap = "none", Warning = "HDR capture unavailable; GDI may clip HDR highlights: " + e.Message };
            } catch { bitmap.Dispose(); throw; }
        }
    }

    static AmoCaptureFrame CaptureDxgi(int x, int y, int width, int height) {
        IntPtr factory = IntPtr.Zero, adapter = IntPtr.Zero, output = IntPtr.Zero, output5 = IntPtr.Zero;
        IntPtr device = IntPtr.Zero, context = IntPtr.Zero, duplication = IntPtr.Zero;
        IntPtr resource = IntPtr.Zero, texture = IntPtr.Zero, staging = IntPtr.Zero;
        bool acquired = false, mapped = false; Bitmap bitmap = null;
        try {
            Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
            Check(CreateDXGIFactory1(ref iid, out factory));
            OutputDesc desc = new OutputDesc(); bool found = false;
            for (uint a = 0; !found; a++) {
                int hr = Method<EnumChild>(factory, 12)(factory, a, out adapter); // EnumAdapters1
                if (hr == unchecked((int)0x887a0002)) break;
                Check(hr);
                for (uint o = 0; ; o++) {
                    hr = Method<EnumChild>(adapter, 7)(adapter, o, out output); // EnumOutputs
                    if (hr == unchecked((int)0x887a0002)) break;
                    Check(hr); Check(Method<GetOutputDesc>(output, 7)(output, out desc));
                    if (desc.Attached != 0 && x >= desc.Bounds.Left && y >= desc.Bounds.Top &&
                        (long)x + width <= desc.Bounds.Right && (long)y + height <= desc.Bounds.Bottom) { found = true; break; }
                    Release(ref output);
                }
                if (!found) Release(ref adapter);
            }
            if (!found) throw new InvalidOperationException("Capture must fit on one connected monitor");
            if (desc.Rotation != 0 && desc.Rotation != 1) throw new NotSupportedException("Rotated monitor");
            bool? hdr = null;
            IntPtr output6 = IntPtr.Zero;
            try {
                output6 = Query(output, "068346e8-aaec-4b84-add7-137f513f77a1");
                OutputDesc1 d; Check(Method<GetOutputDesc1>(output6, 27)(output6, out d));
                hdr = d.ColorSpace == 12; // RGB_FULL_G2084_NONE_P2020
            } catch (COMException) { } finally { Release(ref output6); }
            int level;
            Check(D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
            output5 = Query(output, "80a07424-ab52-42eb-833c-0c42fd282d98");
            Check(Method<Duplicate>(output5, 26)(output5, device, 0, 2, new int[] { Float16, Bgra8 }, out duplication));
            FrameInfo info;
            Check(Method<Acquire>(duplication, 8)(duplication, 1000, out info, out resource)); acquired = true;
            if (info.Protected != 0) throw new InvalidOperationException("Protected content masked by Windows");
            texture = Query(resource, "6f15aaf2-d208-4e89-9ab4-489535d34f9c");
            TextureDesc td; Method<GetTextureDesc>(texture, 10)(texture, out td);
            int format = (int)td.Format;
            if (format != Float16 && format != Bgra8) throw new NotSupportedException("DXGI format " + format);
            int left = x - desc.Bounds.Left, top = y - desc.Bounds.Top;
            if (left + width > td.Width || top + height > td.Height) throw new InvalidOperationException("Display changed during capture");
            td.Usage = 3; td.BindFlags = 0; td.CpuAccessFlags = 0x20000; td.MiscFlags = 0;
            Check(Method<CreateTexture>(device, 5)(device, ref td, IntPtr.Zero, out staging));
            Method<CopyResource>(context, 47)(context, staging, texture);
            Mapped data; Check(Method<MapResource>(context, 14)(context, staging, 0, 1, 0, out data)); mapped = true;
            bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData bits = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try {
                byte[] row = new byte[data.RowPitch];
                for (int py = 0; py < height; py++) {
                    Marshal.Copy(IntPtr.Add(data.Data, checked((top + py) * (int)data.RowPitch)), row, 0, row.Length);
                    byte[] converted = ConvertRow(row, left, width, format);
                    Marshal.Copy(converted, 0, IntPtr.Add(bits.Scan0, py * bits.Stride), converted.Length);
                }
            } finally { bitmap.UnlockBits(bits); }
            AmoCaptureFrame result = new AmoCaptureFrame { Bitmap = bitmap, Backend = "dxgi",
                PixelFormat = format == Float16 ? "R16G16B16A16_FLOAT" : "B8G8R8A8_UNORM", Hdr = hdr,
                ToneMap = format == Float16 ? "reinhard-srgb" : "none",
                Warning = hdr == true && format != Float16 ? "HDR display returned an 8-bit frame; highlights may be clipped" : null };
            bitmap = null; return result;
        } finally {
            if (bitmap != null) bitmap.Dispose();
            if (mapped) Method<UnmapResource>(context, 15)(context, staging, 0);
            if (acquired) Method<ReleaseFrame>(duplication, 14)(duplication);
            Release(ref staging); Release(ref texture); Release(ref resource); Release(ref duplication);
            Release(ref output5); Release(ref output); Release(ref context); Release(ref device); Release(ref adapter); Release(ref factory);
        }
    }
}
