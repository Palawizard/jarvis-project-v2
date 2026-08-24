$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The caller supplies only an executable/argv/cwd JSON object, through a private
# short-lived file named by JARVIS_CONTAINED_SPEC_PATH. This wrapper must never
# read stdin: stdin is the contained target's own prompt channel, and the target
# inherits it untouched along with the already-sanitized environment.
$specPath = $env:JARVIS_CONTAINED_SPEC_PATH
# Drop the bootstrap path before CreateProcessW so the target never inherits it.
Remove-Item -LiteralPath 'Env:JARVIS_CONTAINED_SPEC_PATH' -ErrorAction SilentlyContinue
if (-not $specPath) {
  [Console]::Error.WriteLine('contained process failed: missing control spec')
  exit 127
}
try {
  $payload = [IO.File]::ReadAllText($specPath) | ConvertFrom-Json
} catch {
  [Console]::Error.WriteLine('contained process failed: unreadable control spec')
  exit 127
} finally {
  Remove-Item -LiteralPath $specPath -Force -ErrorAction SilentlyContinue
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Jarvis {
  public static class WindowsJobRunner {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint INFINITE = 0xffffffff;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public uint cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr processAttributes,
      IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
      ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool ok, string operation) {
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new [] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
      var output = new StringBuilder("\"");
      int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') output.Append('\\', slashes * 2 + 1).Append('"');
        else { output.Append('\\', slashes).Append(c); }
        slashes = 0;
      }
      return output.Append('\\', slashes * 2).Append('"').ToString();
    }

    static string CommandLine(string executable, string[] args) {
      var line = new StringBuilder(Quote(executable));
      foreach (string arg in args) line.Append(' ').Append(Quote(arg ?? ""));
      return line.ToString();
    }

    public static int Run(string executable, string[] args, string cwd) {
      IntPtr job = IntPtr.Zero;
      IntPtr limits = IntPtr.Zero;
      PROCESS_INFORMATION process = new PROCESS_INFORMATION();
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero, "CreateJobObject");
        var extended = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        extended.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int extendedSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        limits = Marshal.AllocHGlobal(extendedSize);
        Marshal.StructureToPtr(extended, limits, false);
        Check(SetInformationJobObject(job, 9, limits, (uint)extendedSize), "SetInformationJobObject");

        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10);
        startup.hStdOutput = GetStdHandle(-11);
        startup.hStdError = GetStdHandle(-12);
        var commandLine = new StringBuilder(CommandLine(executable, args));
        Check(CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref startup, out process),
          "CreateProcess");
        Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
        if (ResumeThread(process.hThread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
        CloseHandle(process.hThread);
        process.hThread = IntPtr.Zero;
        WaitForSingleObject(process.hProcess, INFINITE);
        uint exitCode;
        Check(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");

        // A successful leader exit is not completion until every descendant is gone.
        Check(TerminateJobObject(job, exitCode), "TerminateJobObject");
        int accountingSize = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr accounting = Marshal.AllocHGlobal(accountingSize);
        try {
          for (int i = 0; i < 500; i++) {
            Check(QueryInformationJobObject(job, 1, accounting, (uint)accountingSize, IntPtr.Zero), "QueryInformationJobObject");
            var state = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(accounting, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            if (state.ActiveProcesses == 0) return unchecked((int)exitCode);
            System.Threading.Thread.Sleep(10);
          }
          throw new Exception("Windows Job Object did not become empty after termination");
        } finally { Marshal.FreeHGlobal(accounting); }
      } finally {
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero && WaitForSingleObject(process.hProcess, 0) == 258) {
          TerminateProcess(process.hProcess, 127);
          WaitForSingleObject(process.hProcess, 5000);
        }
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        if (limits != IntPtr.Zero) Marshal.FreeHGlobal(limits);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
    }
  }
}
'@

$temporaryCommand = $null
$exitCode = 127
try {
  $executable = [string]$payload.executable
  $arguments = @($payload.args | ForEach-Object { [string]$_ })
  if ($payload.shell -eq $true) {
    $command = $executable
    if ($arguments.Count -gt 0) {
      $command = 'call "' + $executable.Replace('"', '""') + '"'
      foreach ($argument in $arguments) { $command += ' "' + $argument.Replace('"', '""') + '"' }
    }
    $temporaryCommand = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-contained-" + [Guid]::NewGuid().ToString('N') + '.cmd')
    [IO.File]::WriteAllText($temporaryCommand, "@echo off`r`n" + $command + "`r`n", [Text.Encoding]::Default)
    $arguments = @('/d', '/s', '/c', $temporaryCommand)
    $executable = if ($env:ComSpec) { $env:ComSpec } else { "$env:SystemRoot\System32\cmd.exe" }
  } else {
    $resolved = Get-Command -CommandType Application,ExternalScript -Name $executable -ErrorAction Stop | Select-Object -First 1
    $executable = $resolved.Source
    $extension = [IO.Path]::GetExtension($executable)
    if ($extension -in @('.cmd', '.bat')) {
      $command = '"' + $executable.Replace('"', '""') + '"'
      foreach ($argument in $arguments) { $command += ' "' + $argument.Replace('"', '""') + '"' }
      $arguments = @('/d', '/s', '/c', $command)
      $executable = if ($env:ComSpec) { $env:ComSpec } else { "$env:SystemRoot\System32\cmd.exe" }
    } elseif ($extension -eq '.ps1') {
      $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $executable) + $arguments
      $executable = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    }
  }
  $exitCode = [Jarvis.WindowsJobRunner]::Run($executable, $arguments, [string]$payload.cwd)
} catch {
  [Console]::Error.WriteLine("contained process failed: $($_.Exception.Message)")
} finally {
  if ($temporaryCommand) { Remove-Item -LiteralPath $temporaryCommand -Force -ErrorAction SilentlyContinue }
}
exit $exitCode
