# Video-Download für Firefox

## Downloads – Version 1.2.0 (Testversion)

- [Firefox-Erweiterung: FirefoxVideoSaver-1.2.0-unsigned.xpi](https://github.com/serverno666-maker/Firefox_Video_Downloader/releases/download/v1.2.0-unsigned/FirefoxVideoSaver-1.2.0-unsigned.xpi)
- [Quellcode: FirefoxVideoSaver-1.2.0-source.zip](https://github.com/serverno666-maker/Firefox_Video_Downloader/releases/download/v1.2.0-unsigned/FirefoxVideoSaver-1.2.0-source.zip)

**Wichtig:** Die XPI ist **nicht von Mozilla signiert**. Sie lässt sich in normalem Firefox **nicht dauerhaft installieren**. Für einen temporären Test das Quell-ZIP entpacken und `manifest.json` unter `about:debugging` → „Dieser Firefox“ → „Temporäres Add-on laden“ auswählen. Das Add-on verschwindet beim Neustart von Firefox. Für eine dauerhafte Installation ist eine Mozilla-Signatur erforderlich.

Rechtsklick an einer beliebigen Stelle der Webseite: Die Erweiterung sucht in sichtbaren und eingebetteten Playern, im Seitencode sowie in den geladenen Medienanfragen nach Videos. Ein einzelner Treffer steht als **Download dateiname.endung** im Kontextmenü. Mehrere Treffer werden darunter einzeln aufgelistet.

Nach der Auswahl fragt Firefox **bei jedem Download nach dem Speicherort**. Bietet ein Stream mehrere Auflösungen oder Tonsprachen, erscheint zuerst ein kleines Auswahlfenster. Bei Streams wird die Datei vor dem Speicherortdialog im Hintergrund zusammengesetzt; eine Benachrichtigung zeigt den Start an. Der Download öffnet keinen neuen Tab. Die ursprüngliche Webseite kann nach dem Start geschlossen werden.

Unterstützt werden direkte HTTP(S)-Videodateien und abgeschlossene HLS-/statische DASH-Streams. HLS mit MPEG-TS oder fragmentiertem MP4 sowie standardmäßiges AES-128 mit einem in der berechtigten Sitzung erreichbaren Schlüssel sind möglich. Große Streams mit einer Spur werden vorübergehend im lokalen Firefox-Speicher auf der Festplatte abgelegt und nach dem Download entfernt. Getrennte fragmentierte MP4-Bild- und Tonspuren werden bis 512 MiB zu einer MP4-Datei verbunden. Nicht unterstützte Formate, Live-Streams, unzureichender Speicherplatz und serverseitig ablaufende Zugänge können scheitern. Fehler werden als Firefox-Benachrichtigung angezeigt.

DRM-/EME-geschützte Videos können durch eine Firefox-Erweiterung nicht als entschlüsselte Datei gespeichert werden. Dafür muss die offizielle Offline-Funktion der Website verwendet werden. Die Erweiterung enthält keine Aufnahmefunktion und keinen externen Server.

Für Tests kann `manifest.json` über `about:debugging` als temporäres Add-on geladen werden. Eine dauerhafte Installation in normalem Firefox erfordert Mozillas Signatur; das temporäre Add-on verschwindet beim Firefox-Neustart.

Private Fenster sind ausgenommen, damit dort besuchte Medienadressen nicht im Sitzungsspeicher der Erweiterung landen.
