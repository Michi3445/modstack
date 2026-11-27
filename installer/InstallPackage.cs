using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Org.BouncyCastle.Crypto.Signers;
using Org.BouncyCastle.Security;

internal static class InstallPackage
{
    private const string Releases = "https://github.com/Michi3445/modstack/releases/";
    private const string Package = "Modstack-win.zip";
    private const string Root = "Modstack-win32-x64";
    private const long MiB = 1024 * 1024;
    private static readonly HashSet<string> DownloadHosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"
    };
    private static readonly Regex Version = new Regex(@"^(?:0|[1-9][0-9]{0,5})(?:\.(?:0|[1-9][0-9]{0,5})){2}\z");
    private static readonly Regex Device = new Regex(@"^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase);

    public sealed class Envelope
    {
        public string payload { get; set; }
        public string signature { get; set; }
    }

    public sealed class Asset
    {
        public string name { get; set; }
        public long size { get; set; }
        public string sha256 { get; set; }
    }

    public sealed class Manifest
    {
        public int format { get; set; }
        public string platform { get; set; }
        public string version { get; set; }
        public string electron { get; set; }
        public Dictionary<string, Asset> assets { get; set; }
    }

    internal sealed class Progress
    {
        internal readonly string Message;
        internal readonly int Percent;
        internal Progress(string message, int percent = -1)
        {
            Message = message;
            Percent = percent;
        }
    }

    internal static void LoadCrypto()
    {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, args) => {
            if (new AssemblyName(args.Name).Name != "BouncyCastle.Cryptography") return null;
            using (var resource = typeof(InstallPackage).Assembly.GetManifestResourceStream("BouncyCastle.dll.gz"))
            using (var gzip = new GZipStream(resource, CompressionMode.Decompress))
            using (var memory = new MemoryStream()) {
                gzip.CopyTo(memory);
                return Assembly.Load(memory.ToArray());
            }
        };
    }

    internal static async Task<string> InstallAsync(string destination, IProgress<Progress> progress, CancellationToken cancellation)
    {
        destination = Path.GetFullPath(destination);
        CheckDestination(destination);

        string stage = Path.Combine(Path.GetDirectoryName(destination), ".modstack-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        bool preserveStage = false;
        try {
            using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
            using (var handler = new HttpClientHandler { AllowAutoRedirect = false })
            using (var client = new HttpClient(handler)) {
                deadline.CancelAfter(TimeSpan.FromMinutes(12));
                client.DefaultRequestHeaders.UserAgent.ParseAdd("Modstack-Setup/1.0");
                progress.Report(new Progress("Suche die aktuelle Modstack-Version …"));
                Manifest manifest = await GetManifest(client, deadline.Token).ConfigureAwait(false);
                string zip = Path.Combine(stage, Package);
                await Download(client, manifest, zip, progress, deadline.Token).ConfigureAwait(false);
                progress.Report(new Progress("Installiere Modstack " + manifest.version + " …"));
                string unpacked = Path.Combine(stage, "unpacked");
                await Task.Run(() => Extract(zip, unpacked, manifest, cancellation), cancellation).ConfigureAwait(false);
                string next = Path.Combine(unpacked, Root);
                string previous = Path.Combine(stage, "previous");
                cancellation.ThrowIfCancellationRequested();
                CheckDestination(destination);
                if (Directory.Exists(destination)) Directory.Move(destination, previous);
                try { Directory.Move(next, destination); }
                catch {
                    if (Directory.Exists(previous)) {
                        try { Directory.Move(previous, destination); }
                        catch {
                            preserveStage = true;
                            throw new IOException("Die vorige Installation liegt zur Wiederherstellung hier: " + previous);
                        }
                    }
                    throw;
                }
                return manifest.version;
            }
        } catch (OperationCanceledException) {
            if (cancellation.IsCancellationRequested) throw;
            throw new IOException("Der Download hat zu lange gedauert. Bitte versuche es erneut.");
        } finally {
            if (!preserveStage) {
                try { Directory.Delete(stage, true); }
                catch (IOException) {}
                catch (UnauthorizedAccessException) {}
            }
        }
    }

    private static async Task<HttpResponseMessage> Request(HttpClient client, string address, CancellationToken cancellation)
    {
        var uri = new Uri(address);
        for (int i = 0; i < 6; i++) {
            if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo != "" || !DownloadHosts.Contains(uri.Host)) break;
            var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
            int status = (int)response.StatusCode;
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                var location = response.Headers.Location;
                response.Dispose();
                if (location == null) break;
                uri = new Uri(uri, location);
                continue;
            }
            if (response.IsSuccessStatusCode) return response;
            response.Dispose();
            throw new IOException("GitHub hat den Download mit HTTP " + status + " abgelehnt.");
        }
        throw new IOException("Die GitHub-Downloadadresse konnte nicht bestätigt werden.");
    }

    private static async Task<Manifest> GetManifest(HttpClient client, CancellationToken cancellation)
    {
        string url = Releases + "latest/download/modstack-update.json?setup=" + DateTime.UtcNow.ToString("yyyyMMddHHmm");
        using (var response = await Request(client, url, cancellation).ConfigureAwait(false))
        using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
        using (var memory = new MemoryStream()) {
            var buffer = new byte[2048];
            int length;
            while ((length = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation).ConfigureAwait(false)) != 0) {
                if (memory.Length + length > 32768) throw new IOException("Die Update-Information ist zu groß.");
                memory.Write(buffer, 0, length);
            }
            return VerifyManifest(Encoding.UTF8.GetString(memory.ToArray()));
        }
    }

    internal static Manifest VerifyManifest(string json)
    {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 32768 };
        var envelope = serializer.Deserialize<Envelope>(json);
        if (envelope == null || String.IsNullOrEmpty(envelope.payload) || String.IsNullOrEmpty(envelope.signature))
            throw new IOException("Die Update-Information ist unvollständig.");
        byte[] payload = FromBase64Url(envelope.payload);
        byte[] signature = FromBase64Url(envelope.signature);
        using (var publicKey = typeof(InstallPackage).Assembly.GetManifestResourceStream("Modstack.update-public.der")) {
            var signer = new Ed25519Signer();
            signer.Init(false, PublicKeyFactory.CreateKey(publicKey));
            signer.BlockUpdate(payload, 0, payload.Length);
            if (signature.Length != 64 || !signer.VerifySignature(signature))
                throw new IOException("Die Signatur des Modstack-Updates ist ungültig.");
        }
        var manifest = serializer.Deserialize<Manifest>(Encoding.UTF8.GetString(payload));
        Asset asset;
        if (manifest == null || manifest.format != 1 || manifest.platform != "win32-x64" ||
            !Version.IsMatch(manifest.version ?? "") || !Version.IsMatch(manifest.electron ?? "") ||
            manifest.assets == null || !manifest.assets.TryGetValue("full", out asset) || asset == null ||
            asset.name != Package || asset.size <= 0 || asset.size > 600 * MiB ||
            !Regex.IsMatch(asset.sha256 ?? "", @"^[a-fA-F0-9]{64}\z"))
            throw new IOException("Die signierte Windows-Version ist ungültig.");
        return manifest;
    }

    private static byte[] FromBase64Url(string value)
    {
        value = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(value.PadRight((value.Length + 3) / 4 * 4, '='));
    }

    private static async Task Download(HttpClient client, Manifest manifest, string path, IProgress<Progress> progress, CancellationToken cancellation)
    {
        Asset asset = manifest.assets["full"];
        string url = Releases + "download/v" + manifest.version + "/" + Package;
        using (var response = await Request(client, url, cancellation).ConfigureAwait(false))
        using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
        using (var hash = SHA256.Create()) {
            var buffer = new byte[65536];
            long bytes = 0;
            int last = -1;
            int length;
            while ((length = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation).ConfigureAwait(false)) != 0) {
                bytes += length;
                if (bytes > asset.size) throw new IOException("Das Windows-Paket ist größer als angekündigt.");
                hash.TransformBlock(buffer, 0, length, buffer, 0);
                await file.WriteAsync(buffer, 0, length, cancellation).ConfigureAwait(false);
                int percent = (int)(100 * bytes / asset.size);
                if (last != percent) {
                    last = percent;
                    progress.Report(new Progress("Lade Modstack " + manifest.version + " · " + bytes / MiB + " / " + (asset.size + MiB - 1) / MiB + " MB", percent));
                }
            }
            hash.TransformFinalBlock(new byte[0], 0, 0);
            if (bytes != asset.size || !String.Equals(BitConverter.ToString(hash.Hash).Replace("-", ""), asset.sha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Das Windows-Paket wurde nicht vollständig oder unverändert heruntergeladen.");
        }
    }

    private static void Extract(string zip, string target, Manifest manifest, CancellationToken cancellation)
    {
        Directory.CreateDirectory(target);
        string prefix = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long expanded = 0;
        using (var archive = ZipFile.OpenRead(zip)) {
            foreach (var entry in archive.Entries) {
                cancellation.ThrowIfCancellationRequested();
                string file = entry.FullName.Replace('\\', '/');
                bool directory = file.EndsWith("/", StringComparison.Ordinal);
                string[] parts = file.TrimEnd('/').Split('/');
                if (parts[0] != Root || (parts.Length == 1 && !directory)) throw new IOException("Unerwarteter Ordner im Windows-Paket.");
                foreach (string part in parts) {
                    if (part.Length == 0 || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                        part.EndsWith(".") || part.EndsWith(" ") || Device.IsMatch(part))
                        throw new IOException("Ungültiger Dateiname im Windows-Paket.");
                }
                string output = Path.GetFullPath(Path.Combine(target, Path.Combine(parts)));
                if (!output.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !seen.Add(output))
                    throw new IOException("Ungültiger Dateipfad im Windows-Paket.");
                expanded += entry.Length;
                if (expanded > 1200 * MiB) throw new IOException("Das entpackte Windows-Paket ist zu groß.");
                if (directory) Directory.CreateDirectory(output);
                else {
                    Directory.CreateDirectory(Path.GetDirectoryName(output));
                    entry.ExtractToFile(output);
                }
            }
        }
        string app = Path.Combine(target, Root);
        if (!LooksInstalled(app) || File.ReadAllText(Path.Combine(app, "version")).Trim() != manifest.electron)
            throw new IOException("Die Windows-App ist unvollständig.");
    }

    private static bool LooksInstalled(string directory)
    {
        return File.Exists(Path.Combine(directory, "Modstack.exe")) && File.Exists(Path.Combine(directory, "resources", "app.asar"));
    }

    private static void CheckDestination(string destination)
    {
        if (File.Exists(destination)) throw new IOException("Der Modstack-Installationsort ist bereits belegt.");
        if (!Directory.Exists(destination)) return;
        if ((File.GetAttributes(destination) & FileAttributes.ReparsePoint) != 0 || !LooksInstalled(destination))
            throw new IOException("Am Installationsort befindet sich bereits ein anderer Ordner.");

        string executable = Path.Combine(destination, "Modstack.exe");
        foreach (Process process in Process.GetProcessesByName("Modstack")) {
            using (process) {
                string running;
                try { running = process.MainModule.FileName; }
                catch (System.ComponentModel.Win32Exception) { continue; }
                catch (InvalidOperationException) { continue; }
                if (String.Equals(running, executable, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Schließe Modstack vollständig, bevor du es erneut installierst.");
            }
        }
    }
}
