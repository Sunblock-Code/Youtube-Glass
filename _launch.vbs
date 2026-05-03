Option Explicit
' Hidden launcher for Glass. Used by run.bat (and can be double-clicked
' directly for a fully silent start once dependencies are installed).
Dim sh, fso
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("Wscript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
' Run npm start in a fully hidden console window, non-blocking.
sh.Run "cmd /c npm start", 0, False
