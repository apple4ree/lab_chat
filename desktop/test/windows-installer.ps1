param([Parameter(Mandatory=$true)][string]$Executable, [string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
$arguments = @('/S')
if ($InstallDirectory) { $arguments += "/D=$InstallDirectory" }
$installer = Start-Process -FilePath $Executable -ArgumentList $arguments -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "Installer exited with $($installer.ExitCode)" }
