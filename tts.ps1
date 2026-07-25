Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice("Microsoft Huihui Desktop")
$synth.SetOutputToWaveFile($args[0])
$synth.Rate = 0
$synth.Volume = 100
$text = Get-Content -Path $args[1] -Raw -Encoding UTF8
$synth.Speak($text)
$synth.Dispose()
Write-Host "TTS_OK"
