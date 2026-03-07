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
; Ikona aplikacji (wygeneruj z PNG: node scripts/generate-icon-ico.js)
SetupIconFile=..\..\web\public\icon.ico
UninstallDisplayIcon={app}\icon.ico

[Languages]
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Ikona dla skrótów i „Programy i funkcje”
Source: "..\..\web\public\icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\Start BeatForge.bat"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Uruchom BeatForge"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\Start BeatForge.bat"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon; Comment: "Uruchom BeatForge"

[Run]
Filename: "{app}\Start BeatForge.bat"; Description: "Uruchom BeatForge teraz"; Flags: postinstall nowait skipifsilent unchecked
Filename: "{app}\INSTRUKCJA.txt"; Description: "Otwórz instrukcję (wymagania: Node.js, FFmpeg)"; Flags: postinstall shellexec skipifsilent unchecked

[Messages]
WelcomeLabel2=Zainstaluje [name] na Twoim komputerze.%n%nWymagania: Node.js 20+ oraz FFmpeg (w PATH). Jeśli ich nie masz, po instalacji przeczytaj plik INSTRUKCJA.txt w folderze aplikacji.

[Code]
var
  RequirementsPage: TOutputMsgWizardPage;
  NodeJsFound, FFmpegFound: Boolean;

function CheckNodeJs(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/C node --version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

function CheckFFmpeg(): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('cmd.exe', '/C ffmpeg -version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
end;

procedure InitializeWizard();
var
  StatusMsg: String;
begin
  NodeJsFound := CheckNodeJs();
  FFmpegFound := CheckFFmpeg();
  
  StatusMsg := '';
  
  if NodeJsFound then
    StatusMsg := StatusMsg + '✓ Node.js - ZNALEZIONY' + #13#10
  else
    StatusMsg := StatusMsg + '✗ Node.js - BRAK (wymagany Node.js 20+)' + #13#10;
    
  if FFmpegFound then
    StatusMsg := StatusMsg + '✓ FFmpeg - ZNALEZIONY' + #13#10
  else
    StatusMsg := StatusMsg + '✗ FFmpeg - BRAK (wymagany w PATH)' + #13#10;
  
  StatusMsg := StatusMsg + #13#10;
  
  if not NodeJsFound then
    StatusMsg := StatusMsg + 'Pobierz Node.js: https://nodejs.org' + #13#10;
    
  if not FFmpegFound then
    StatusMsg := StatusMsg + 'Pobierz FFmpeg: https://ffmpeg.org/download.html' + #13#10;
  
  if NodeJsFound and FFmpegFound then
    StatusMsg := StatusMsg + 'Wszystko gotowe! Możesz kontynuować instalację.'
  else
    StatusMsg := StatusMsg + #13#10 + 'Instalacja kontynuuje, ale BeatForge nie zadziała bez tych narzędzi.';
  
  RequirementsPage := CreateOutputMsgPage(wpWelcome,
    'Sprawdzanie wymagań', 
    'Instalator sprawdził dostępność wymaganych narzędzi:',
    StatusMsg);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  
  // Pokaż ostrzeżenie jeśli brakuje wymagań
  if (CurPageID = RequirementsPage.ID) and (not NodeJsFound or not FFmpegFound) then
  begin
    if MsgBox('Wykryto brakujące wymagania. BeatForge nie będzie działać bez Node.js i FFmpeg.' + #13#10#13#10 + 
              'Czy na pewno chcesz kontynuować instalację?', 
              mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;