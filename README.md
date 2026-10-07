# Video-Download für Firefox

Rechtsklick an einer beliebigen Stelle der Webseite: Die Erweiterung sucht in sichtbaren und eingebetteten Playern, im Seitencode sowie in den geladenen Medienanfragen nach Videos. Ein einzelner Treffer steht als **Download dateiname.endung** im Kontextmenü. Mehrere Treffer werden darunter einzeln aufgelistet.

Nach der Auswahl fragt Firefox **bei jedem Download sofort nach dem Speicherort**, bevor die Videosegmente geladen werden. Bietet ein Stream mehrere Auflösungen oder Tonsprachen, erscheint zuerst ein kleines Auswahlfenster. Die Datei wird anschließend über Firefox' normalen Download-Manager gespeichert; dort ist der Fortschritt sichtbar. Der Download öffnet keinen neuen Tab. Die ursprüngliche Webseite kann nach dem Start geschlossen werden.

Unterstützt werden direkte HTTP(S)-Videodateien und abgeschlossene HLS-/statische DASH-Streams. HLS mit MPEG-TS oder fragmentiertem MP4 sowie standardmäßiges AES-128 mit einem in der berechtigten Sitzung erreichbaren Schlüssel sind möglich. Streams mit einer Spur werden ohne vorherige Komplettladung direkt in die gewählte Datei geschrieben. Getrennte fragmentierte MP4-Bild- und Tonspuren werden bis 512 MiB zu einer MP4-Datei verbunden; auch dabei erfolgt die Dateiauswahl vor dem Laden. Nicht unterstützte Formate, Live-Streams, unzureichender Speicherplatz und serverseitig ablaufende Zugänge können scheitern. Fehler werden als Firefox-Benachrichtigung angezeigt.

DRM-/EME-geschützte Videos können durch eine Firefox-Erweiterung nicht als entschlüsselte Datei gespeichert werden. Dafür muss die offizielle Offline-Funktion der Website verwendet werden. Die Erweiterung enthält keine Aufnahmefunktion und keinen externen Server.

Für Tests kann `manifest.json` über `about:debugging` als temporäres Add-on geladen werden. Eine dauerhafte Installation in normalem Firefox erfordert Mozillas Signatur; das temporäre Add-on verschwindet beim Firefox-Neustart.

Private Fenster sind ausgenommen, damit dort besuchte Medienadressen nicht im Sitzungsspeicher der Erweiterung landen.

Die Berechtigung für alle Websites ist nötig, um Player, eingebettete Frames und Medienanfragen auf der jeweils geöffneten Seite zu finden. Die Berechtigung zum Bearbeiten von Netzwerkanfragen ermöglicht es, zusammengesetzte Streams an Firefox' Download-Manager zu übergeben. Ausschließlich eigene, einmalig markierte Download-Anfragen werden dafür bearbeitet. Erkannte Medienadressen werden nur lokal in der Firefox-Sitzung verarbeitet; die Erweiterung sendet keine Telemetrie an einen eigenen Server.
