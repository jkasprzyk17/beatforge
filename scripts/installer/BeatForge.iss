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
AppComments=Beat-synced short vertical videos with AI captions
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
; Zawsze pokazuj stronę wyboru folderu — użytkownik może wybrać dowolny dysk (np. D:\)
DisableDirPage=no
DisableProgramGroupPage=yes
OutputDir=..\..\release
OutputBaseFilename=BeatForge-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardResizable=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Ikona aplikacji (wygeneruj z PNG: node scripts/generate-icon-ico.js)
SetupIconFile=..\..\web\public\icon.ico
UninstallDisplayIcon={app}\icon.ico
; Wygląd kreatora: ciemny panel boczny (#16213e), ikona BeatForge w nagłówku
; (Puste WizardImageFile = tylko kolor bez obrazka; by przywrócić domyślny, usuń linię WizardImageFile=)
WizardImageFile=
WizardImageBackColor=#16213e
WizardSmallImageFile=..\..\web\public\icon.png

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
WelcomeLabel1=Witaj w kreatorze instalacji [name]
WelcomeLabel2=Zainstaluje [name] na Twoim komputerze.%n%nWymagania: Node.js 20+ oraz FFmpeg (w PATH).%nJeśli ich nie masz, po instalacji przeczytaj plik INSTRUKCJA.txt w folderze aplikacji.
FinishedHeadingLabel=Instalacja zakończona
FinishedLabel=BeatForge został pomyślnie zainstalowany.%n%nDane (baza, muzyka, eksporty) są zapisywane w folderze użytkownika: AppData\Roaming\BeatForge
ClickFinish=Kliknij Zakończ, aby zamknąć kreator. Skrót uruchomienia znajdziesz w menu Start.
BeveledLabel=Beat-synced short vertical videos with AI captions
ReadyLabel=Kliknij Instaluj, aby rozpocząć instalację BeatForge w wybranej lokalizacji.
; Strona „Wybierz lokalizację” — podpowiedź, że można wybrać dowolny dysk
SelectDirLabel3=Wybierz folder instalacji. Możesz wybrać dowolny dysk (np. D:\BeatForge) — kliknij Przeglądaj.

[Code]
var
  RequirementsPage: TOutputMsgWizardPage;
  DrivePage: TInputOptionWizardPage;
  NodeJsFound, FFmpegFound: Boolean;
  SelectedDrive: String;

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
    StatusMsg := StatusMsg + '  [OK] Node.js - znaleziony' + #13#10
  else
    StatusMsg := StatusMsg + '  [--] Node.js - brak (wymagany 20+)' + #13#10;
    
  if FFmpegFound then
    StatusMsg := StatusMsg + '  [OK] FFmpeg - znaleziony' + #13#10
  else
    StatusMsg := StatusMsg + '  [--] FFmpeg - brak (wymagany w PATH)' + #13#10;
  
  StatusMsg := StatusMsg + #13#10;
  
  if not NodeJsFound then
    StatusMsg := StatusMsg + '  Pobierz Node.js: https://nodejs.org' + #13#10;
    
  if not FFmpegFound then
    StatusMsg := StatusMsg + '  Pobierz FFmpeg: https://ffmpeg.org/download.html' + #13#10;
  
  if NodeJsFound and FFmpegFound then
    StatusMsg := StatusMsg + #13#10 + 'Wszystko gotowe — możesz kontynuować instalację.'
  else
    StatusMsg := StatusMsg + #13#10 + 'Instalacja będzie kontynuowana, ale BeatForge nie zadziała bez Node.js i FFmpeg.';
  
  RequirementsPage := CreateOutputMsgPage(wpWelcome,
    'Wymagania systemowe',
    'Sprawdzono dostępność narzędzi wymaganych przez BeatForge:',
    StatusMsg);

  // Strona wyboru dysku — domyślna ścieżka będzie na wybranym dysku
  DrivePage := CreateInputOptionPage(RequirementsPage.ID,
    'Wybierz dysk instalacji',
    'Na którym dysku chcesz zainstalować BeatForge?',
    'Wybierz dysk. Na następnej stronie możesz zmienić pełną ścieżkę (np. D:\BeatForge).',
    True, False);
  DrivePage.Add('Dysk C: (domyślny)');
  DrivePage.Add('Dysk D:');
  DrivePage.Add('Dysk E:');
  DrivePage.Add('Dysk F:');
  DrivePage.Add('Inny — wybiorę folder na stronie „Wybierz lokalizację”');
  DrivePage.Values[0] := True;
  SelectedDrive := 'C';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  
  if (CurPageID = RequirementsPage.ID) and (not NodeJsFound or not FFmpegFound) then
  begin
    if MsgBox('Wykryto brakujące wymagania. BeatForge nie będzie działać bez Node.js i FFmpeg.' + #13#10#13#10 + 
              'Czy na pewno chcesz kontynuować instalację?', 
              mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;

  // Zapisz wybrany dysk przed przejściem do strony katalogu
  if CurPageID = DrivePage.ID then
  begin
    if DrivePage.Values[4] then
      SelectedDrive := ''
    else if DrivePage.Values[0] then
      SelectedDrive := 'C'
    else if DrivePage.Values[1] then
      SelectedDrive := 'D'
    else if DrivePage.Values[2] then
      SelectedDrive := 'E'
    else if DrivePage.Values[3] then
      SelectedDrive := 'F'
    else
      SelectedDrive := 'C';
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // Po wyborze dysku ustaw domyślną ścieżkę na stronie „Wybierz lokalizację”
  if (CurPageID = wpSelectDir) and (SelectedDrive <> '') then
    WizardForm.DirEdit.Text := SelectedDrive + ':\BeatForge';
end;