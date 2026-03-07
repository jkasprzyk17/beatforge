; BeatForge — Inno Setup script (instalator .exe dla Windows)
; Uruchom: iscc scripts\installer\BeatForge.iss  (z katalogu projektu, na Windows)
; Wymaga: wcześniej wykonane npm run build:win (folder release\BeatForge-Windows)

#define MyAppName "BeatForge"
#define MyAppVersion "1.0"
#define MyAppPublisher "BeatForge"
#define MyAppURL "https://github.com/beatforge"
#define SourceDir "..\..\release\BeatForge-Windows"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\release
OutputBaseFilename=BeatForge-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\Start BeatForge.bat"; WorkingDir: "{app}"; Comment: "Uruchom BeatForge"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\Start BeatForge.bat"; WorkingDir: "{app}"; Tasks: desktopicon; Comment: "Uruchom BeatForge"

[Run]
Filename: "{app}\INSTRUKCJA.txt"; Description: "Otwórz instrukcję (wymagania: Node.js, FFmpeg)"; Flags: postinstall shellexec skipifsilent

[Messages]
WelcomeLabel2=Zainstaluje [name] na Twoim komputerze.%n%nWymagania: Node.js 20+ oraz FFmpeg (w PATH). Jeśli ich nie masz, po instalacji przeczytaj plik INSTRUKCJA.txt w folderze aplikacji.
