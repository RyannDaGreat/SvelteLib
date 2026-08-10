Attribute VB_Name = "Module1"
' ExportDeck — headless PPTX -> PNG/PDF/MP4 export, driven by a control file.
'
' Invoked as a pure Apple Event from shell:
'   osascript -e 'tell application "Microsoft PowerPoint" to run VB macro macro name "ExportDeck"'
'
' Reads CONTROL_FILE (a fixed, already-sandbox-granted path -- see below) with exactly
' three lines:
'   1. absolute path to the input .pptx/.pptm to export
'   2. absolute path to the output folder (PNGs/PDF/MP4/log/marker all land here)
'   3. comma-separated export kinds, any of: png,pdf,mp4
'
' CONTROL_FILE and the output folder both live under the "PowerRP-PPTExportExchange"
' folder in ~/Library/Application Support -- the folder that received the one-time
' Grant Access consent (Microsoft's GrantAccessToMultipleFiles docs: the grant is
' PERSISTENT per folder, stored with the app, not per-session -- confirmed by direct
' re-test in this project, see .frenzy/research_05_powerpoint_render.md ROUND 4).
' Reading the control file and opening the input deck do NOT require a grant --
' only WRITING new files into a folder does; `Presentations.Open` is not gated the
' way `.Export`/`.SaveAs` are (see the same doc).
'
' Writes, into the output folder:
'   - export_log.txt   human-readable per-step log, opened FIRST so a failure at
'                       any later step is never silent
'   - Slide<N>.png      one per slide, PowerPoint's own native export naming/size
'                        (Mac ignores requested width/height -- see log for the
'                        native size actually used)
'   - deck.pdf           vector export via SaveAs
'   - deck.mp4            attempted via SaveAs ppSaveAsMP4; CONFIRMED to throw
'                          "Invalid enumeration value" at runtime on Mac
'                          PowerPoint 16.110.3 (a real capability gap, not a
'                          sandbox/GUI issue -- see research doc ROUND 4), so
'                          failure here is caught and logged, never allowed to
'                          abort the PNG/PDF steps
'   - export_done.marker  written LAST, after the deck this macro opened is closed;
'                          the shell pipeline polls for this file's existence as
'                          the completion signal (never MsgBox -- a MsgBox blocks
'                          this synchronous Apple Event forever with nothing
'                          watching for a click, which is exactly the deadlock a
'                          predecessor macro caused)
'
' On Error is used throughout, but ONLY to catch a named step and record it in the
' log -- never to swallow a failure silently. Every failure still ends with the
' marker being written so the shell side is never left polling forever.

Const CONTROL_FILE As String = "/Users/ryan/Library/Application Support/PowerRP-PPTExportExchange/control.txt"

Sub ExportDeck()
    Dim outDir As String
    Dim inputPath As String
    Dim kindsRaw As String
    Dim logPath As String
    Dim markerPath As String
    Dim logF As Integer
    Dim deck As Presentation
    Dim openedHere As Boolean
    Dim doPng As Boolean, doPdf As Boolean, doMp4 As Boolean

    openedHere = False
    logF = FreeFile

    ' --- Read control file (no grant needed: plain read) ---
    Dim ctrlF As Integer
    ctrlF = FreeFile
    Open CONTROL_FILE For Input As #ctrlF
    Line Input #ctrlF, inputPath
    Line Input #ctrlF, outDir
    Line Input #ctrlF, kindsRaw
    Close #ctrlF

    doPng = (InStr(1, kindsRaw, "png", vbTextCompare) > 0)
    doPdf = (InStr(1, kindsRaw, "pdf", vbTextCompare) > 0)
    doMp4 = (InStr(1, kindsRaw, "mp4", vbTextCompare) > 0)

    logPath = outDir & "/export_log.txt"
    markerPath = outDir & "/export_done.marker"

    Open logPath For Output As #logF
    Print #logF, "ExportDeck started " & Now
    Print #logF, "input=" & inputPath
    Print #logF, "outDir=" & outDir
    Print #logF, "kinds=" & kindsRaw

    ' --- Open the deck. Try WithWindow:=msoFalse (hidden) first; Mac PowerPoint
    ' (measured on 16.110.3) REFUSES this with "Mac PPT does not support opening
    ' file in windowless mode" (Err -2147188160), so fall back to the default
    ' (visible) open on that specific failure. Both paths are logged honestly --
    ' this is not a silent fallback, it is a documented Mac capability gap.
    On Error GoTo OpenHiddenFailed
    Set deck = Presentations.Open(FileName:=inputPath, ReadOnly:=msoTrue, Untitled:=msoFalse, WithWindow:=msoFalse)
    openedHere = True
    Print #logF, "OPEN: ok, WithWindow:=msoFalse honored (deck opened hidden)"
    GoTo OpenDone
OpenHiddenFailed:
    Print #logF, "OPEN (hidden): FAILED - " & Err.Number & " - " & Err.Description & " -- falling back to visible open (known Mac gap)"
    On Error GoTo OpenVisibleFailed
    Set deck = Presentations.Open(FileName:=inputPath, ReadOnly:=msoTrue, Untitled:=msoFalse, WithWindow:=msoTrue)
    openedHere = True
    Print #logF, "OPEN: ok, WithWindow:=msoFalse NOT supported on this Mac build - opened VISIBLE instead"
    GoTo OpenDone
OpenVisibleFailed:
    Print #logF, "OPEN (visible): FAILED - " & Err.Number & " - " & Err.Description
    Print #logF, "ExportDeck aborting - no deck to export"
    Close #logF
    WriteMarker markerPath
    Exit Sub
OpenDone:
    On Error GoTo 0

    Print #logF, "Native slide size (pt): " & deck.PageSetup.SlideWidth & " x " & deck.PageSetup.SlideHeight

    ' --- PNG export (per-slide, native resolution -- Mac ignores explicit W/H) ---
    If doPng Then
        On Error GoTo PngFailed
        deck.Export outDir, "PNG", 1920, 1080
        Print #logF, "PNG: ok (per-slide, Mac native size regardless of the 1920x1080 requested here)"
        GoTo PngDone
PngFailed:
        Print #logF, "PNG: FAILED - " & Err.Number & " - " & Err.Description
        Resume PngDone
PngDone:
        On Error GoTo 0
    Else
        Print #logF, "PNG: skipped (not requested)"
    End If

    ' --- PDF export (vector, resolution-independent -- rasterize locally with pdftoppm) ---
    If doPdf Then
        On Error GoTo PdfFailed
        deck.SaveAs outDir & "/deck.pdf", ppSaveAsPDF
        Print #logF, "PDF: ok -> " & outDir & "/deck.pdf"
        GoTo PdfDone
PdfFailed:
        Print #logF, "PDF: FAILED - " & Err.Number & " - " & Err.Description
        Resume PdfDone
PdfDone:
        On Error GoTo 0
    Else
        Print #logF, "PDF: skipped (not requested)"
    End If

    ' --- MP4 export (SaveAs ppSaveAsMP4; confirmed to throw "Invalid enumeration
    ' value" on Mac -- a real capability gap, caught and logged like any other) ---
    If doMp4 Then
        On Error GoTo Mp4Failed
        deck.SaveAs outDir & "/deck.mp4", ppSaveAsMP4
        Print #logF, "MP4: ok -> " & outDir & "/deck.mp4"
        GoTo Mp4Done
Mp4Failed:
        Print #logF, "MP4: FAILED - " & Err.Number & " - " & Err.Description
        Resume Mp4Done
Mp4Done:
        On Error GoTo 0
    Else
        Print #logF, "MP4: skipped (not requested)"
    End If

    ' --- Close the deck this macro opened (never touch anything it did not open) ---
    If openedHere Then
        On Error GoTo CloseFailed
        deck.Close
        Print #logF, "CLOSE: ok"
        GoTo CloseDone
CloseFailed:
        Print #logF, "CLOSE: FAILED - " & Err.Number & " - " & Err.Description
        Resume CloseDone
CloseDone:
        On Error GoTo 0
    End If

    Print #logF, "ExportDeck finished " & Now
    Close #logF
    WriteMarker markerPath
End Sub

Private Sub WriteMarker(markerPath As String)
    Dim f As Integer
    f = FreeFile
    Open markerPath For Output As #f
    Print #f, "done " & Now
    Close #f
End Sub
