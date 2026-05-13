; SPDX-License-Identifier: AGPL-3.0-or-later
;
; Custom NSIS hooks for Subcast (Phase 4.3 / decision 24).
;
; electron-builder calls `customUnInit` very early in the uninstall flow,
; before any files are removed. We use it to ask whether the user wants
; their app data (cached videos, transcribed cues, downloaded models)
; removed too. The default answer is "No" — keeping data is the
; conservative choice that avoids destroying gigabytes of work if a user
; uninstalls planning to immediately reinstall.

!macro customUnInit
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Also remove your Subcast data folder (cached videos, transcripts, downloaded models)?$\r$\n$\r$\nDefault: No (keeps your data for a future reinstall)." \
    /SD IDNO \
    IDYES subcast_remove_userdata \
    IDNO subcast_keep_userdata

  subcast_remove_userdata:
    ; %APPDATA% expands to the per-user Roaming folder; Electron's
    ; app.getPath('userData') under our productName lands at
    ; %APPDATA%\Subcast on win32-x64.
    RMDir /r "$APPDATA\Subcast"
    Goto subcast_userdata_done

  subcast_keep_userdata:
    ; Explicit no-op for clarity.
    Goto subcast_userdata_done

  subcast_userdata_done:
!macroend
