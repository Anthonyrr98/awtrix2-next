B4J=true
Group=Default Group
ModulesStructureVersion=1
Type=Class
Version=7.31
@EndOfDesignText@
'GifPlayer - 由 AWTRIX2-Next 桥接层推送 GIF 帧数据，在 32x8 矩阵上逐帧播放
Sub Class_Globals
	Dim App As AWTRIX
	Private frames As List
	Private frameIndex As Int = 0
	Private frameDelay As Int = 100
	Private loopCount As Int = 0
	Private currentLoop As Int = 0
	Private lastFrameTime As Long = 0
	Private gifName As String = ""
	Private isPlaying As Boolean = False
	Private currentJsonModified As Long = 0
	Private playbackStartedAt As Long = 0
	Private Const MaxPlaybackMs As Long = 120000
End Sub

Public Sub Initialize() As String
	App.Initialize(Me, "App")
	App.Name = "GifPlayer"
	App.Version = "1.3"
	App.Author = "AWTRIX2-Next"
	App.Description = "播放桥接层推送的 GIF 像素动画"
	App.CoverIcon = 709
	' 公网 Host 场景下限制为 4 FPS，避免长时间满帧推送压垮 ESP8266 连接。
	App.Tick = 250
	' 不锁定应用，确保 Host 的 Time 切换命令可以立即退出 GIF。
	App.Lock = False
	App.setHidden(False)
	frames.Initialize
	App.MakeSettings
	Return "AWTRIX20"
End Sub

Public Sub GetNiceName() As String
	Return App.Name
End Sub

Public Sub Run(Tag As String, Params As Map) As Object
	Return App.interface(Tag, Params)
End Sub

Private Sub App_Started
	frameIndex = 0
	currentLoop = 0
	lastFrameTime = 0
	currentJsonModified = 0
	playbackStartedAt = DateTime.Now
	loadCurrentGif
End Sub

Private Sub loadCurrentGif
	Dim dir As String = File.DirApp
	Dim filename As String = "gifs/current.json"
	If Not(File.Exists(dir, filename)) Then
		isPlaying = False
		Return
	End If
	Try
		Dim parser As JSONParser
		parser.Initialize(File.ReadString(dir, filename))
		Dim data As Map = parser.NextObject
		gifName = data.Get("name")
		frameDelay = Max(20, data.Get("delay"))
		loopCount = data.Get("loop")
		frames = data.Get("frames")
		isPlaying = frames.Size > 0
		frameIndex = 0
		currentLoop = 0
		lastFrameTime = 0
		currentJsonModified = File.LastModified(dir, filename)
	Catch
		isPlaying = False
		Log("GifPlayer load error: " & LastException.Message)
	End Try
End Sub

Private Sub App_genFrame
	' 屏幕端硬超时：即使公网切换命令丢失，也会在 120 秒后自行退出。
	If playbackStartedAt > 0 And DateTime.Now - playbackStartedAt >= MaxPlaybackMs Then
		isPlaying = False
		App.finish
		Return
	End If

	'热切换：检测 current.json 修改时间，变化时重新加载
	Dim dir As String = File.DirApp
	Dim filename As String = "gifs/current.json"
	If File.Exists(dir, filename) Then
		Dim modTime As Long = File.LastModified(dir, filename)
		If modTime <> currentJsonModified And modTime > 0 Then
			loadCurrentGif
		End If
	End If

	If Not(isPlaying) Or frames.Size = 0 Then
		App.drawText("NO GIF", 2, 1, Null)
		Return
	End If

	Dim now As Long = DateTime.Now
	If lastFrameTime = 0 Or now - lastFrameTime >= frameDelay Then
		lastFrameTime = now
		frameIndex = frameIndex + 1
		If frameIndex >= frames.Size Then
			frameIndex = 0
			If loopCount > 0 Then
				currentLoop = currentLoop + 1
				If currentLoop >= loopCount Then
					App.finish
					Return
				End If
			End If
		End If
	End If

	Dim frameList As List = frames.Get(frameIndex)
	Dim count As Int = frameList.Size
	Dim bmp(count) As Short
	For i = 0 To count - 1
		bmp(i) = frameList.Get(i)
	Next
	App.drawBMP(0, 0, bmp, 32, 8)
End Sub

Private Sub App_Exited
	isPlaying = False
End Sub
