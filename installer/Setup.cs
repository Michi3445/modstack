using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal sealed class Setup : Form
{
    private readonly string destination = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Modstack");
    private readonly Label note;
    private readonly ProgressBar progress;
    private readonly Button primary;
    private readonly Button cancel;
    private CancellationTokenSource downloading;
    private bool installed;

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (!Environment.Is64BitOperatingSystem) {
            MessageBox.Show("Modstack benötigt Windows mit 64 Bit.", "Modstack Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        bool first;
        using (var mutex = new Mutex(true, @"Local\Modstack.WindowsSetup", out first)) {
            if (!first) return;
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            InstallPackage.LoadCrypto();
            Application.Run(new Setup());
        }
    }

    private Setup()
    {
        Text = "Modstack Setup";
        Font = new Font("Segoe UI", 10);
        ClientSize = new Size(540, 235);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        BackColor = Color.FromArgb(19, 24, 29);
        ForeColor = Color.FromArgb(238, 243, 247);

        var title = new Label {
            Text = "Modstack installieren", Location = new Point(24, 23),
            AutoSize = true, Font = new Font("Segoe UI Semibold", 19),
        };
        note = new Label {
            Text = "Der Installer lädt die neueste Windows-Version und legt eine Verknüpfung im Startmenü an.",
            Location = new Point(26, 70), Size = new Size(485, 49),
        };
        progress = new ProgressBar { Location = new Point(26, 134), Size = new Size(488, 8), Visible = false };
        primary = new Button {
            Text = "Installieren", Location = new Point(355, 176), Size = new Size(159, 36),
            FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(75, 210, 179), ForeColor = Color.FromArgb(15, 29, 24),
        };
        primary.FlatAppearance.BorderSize = 0;
        cancel = new Button {
            Text = "Schließen", Location = new Point(233, 176), Size = new Size(112, 36),
            FlatStyle = FlatStyle.Flat, BackColor = BackColor, ForeColor = ForeColor,
        };
        cancel.FlatAppearance.BorderColor = Color.FromArgb(86, 97, 109);
        primary.Click += InstallOrStart;
        cancel.Click += (sender, args) => Close();
        FormClosing += (sender, args) => {
            if (downloading == null) return;
            args.Cancel = true;
            downloading.Cancel();
            cancel.Enabled = false;
        };
        AcceptButton = primary;
        CancelButton = cancel;
        Controls.AddRange(new Control[] { title, note, progress, primary, cancel });
    }

    private async void InstallOrStart(object sender, EventArgs args)
    {
        if (installed) {
            try {
                Process.Start(new ProcessStartInfo(Path.Combine(destination, "Modstack.exe")) {
                    WorkingDirectory = destination, UseShellExecute = true,
                });
                Close();
            } catch (Exception error) { note.Text = error.Message; }
            return;
        }
        primary.Enabled = false;
        cancel.Text = "Abbrechen";
        progress.Visible = true;
        downloading = new CancellationTokenSource();
        try {
            var updates = new Progress<InstallPackage.Progress>(update => {
                if (downloading == null || downloading.IsCancellationRequested) return;
                note.Text = update.Message;
                progress.Style = update.Percent < 0 ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
                if (update.Percent >= 0) progress.Value = update.Percent;
            });
            string version = await InstallPackage.InstallAsync(destination, updates, downloading.Token);
            bool shortcut = CreateShortcut(destination, Environment.GetFolderPath(Environment.SpecialFolder.Programs));
            installed = true;
            primary.Text = "Modstack starten";
            note.Text = "Modstack " + version + " ist installiert." +
                (shortcut ? " Du findest es im Startmenü." : " Die Startmenü-Verknüpfung konnte nicht erstellt werden.");
        } catch (OperationCanceledException) {
            note.Text = "Installation abgebrochen. Du kannst es erneut versuchen.";
        } catch (Exception error) {
            note.Text = error.Message;
            primary.Text = "Erneut versuchen";
        } finally {
            downloading.Dispose();
            downloading = null;
            progress.Visible = false;
            cancel.Text = "Schließen";
            cancel.Enabled = true;
            primary.Enabled = true;
        }
    }

    internal static bool CreateShortcut(string destination, string programs)
    {
        try {
            if (String.IsNullOrEmpty(programs)) return false;
            Directory.CreateDirectory(programs);
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            dynamic shortcut = shell.CreateShortcut(Path.Combine(programs, "Modstack.lnk"));
            shortcut.TargetPath = Path.Combine(destination, "Modstack.exe");
            shortcut.WorkingDirectory = destination;
            shortcut.Description = "Modstack";
            shortcut.Save();
            return true;
        } catch { return false; }
    }
}
