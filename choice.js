"use strict";

const token = decodeURIComponent(location.hash.slice(1));
const filename = document.getElementById("filename");
const form = document.getElementById("choice-form");
const videoRow = document.getElementById("video-row");
const audioRow = document.getElementById("audio-row");
const videoSelect = document.getElementById("video-choice");
const audioSelect = document.getElementById("audio-choice");
const errorBox = document.getElementById("error");
const downloadButton = document.getElementById("download");
let videoChoices = [];
let audioChoices = [];
let streamFormat = "";

function option(label, value, disabled = false) {
  const element = document.createElement("option");
  element.textContent = label;
  element.value = String(value);
  element.disabled = disabled;
  return element;
}

function fillSelect(select, choices) {
  select.replaceChildren(option("Bitte auswählen…", ""));
  for (const choice of choices) select.append(option(choice.label, choice.index, choice.supported === false));
  select.value = "";
}

function visibleAudio() {
  if (streamFormat !== "hls") return audioChoices;
  const selected = videoChoices.find((item) => String(item.index) === videoSelect.value);
  if (!selected?.audioGroup) return [];
  return audioChoices.filter((item) => item.groupId === selected.audioGroup);
}

function updateAudio() {
  const choices = visibleAudio();
  audioRow.hidden = choices.length <= 1;
  audioSelect.disabled = audioRow.hidden;
  audioSelect.required = !audioRow.hidden;
  fillSelect(audioSelect, choices);
  if (choices.length === 1) audioSelect.value = String(choices[0].index);
}

async function load() {
  try {
    const response = await browser.runtime.sendMessage({ type: "choice-get", token });
    if (response?.error) throw new Error(response.error);
    filename.textContent = response.filename || "Video";
    streamFormat = response.format || "";
    videoChoices = response.video || [];
    audioChoices = response.audio || [];
    videoRow.hidden = videoChoices.length <= 1;
    videoSelect.disabled = videoRow.hidden;
    videoSelect.required = !videoRow.hidden;
    fillSelect(videoSelect, videoChoices);
    if (videoChoices.length === 1) videoSelect.value = String(videoChoices[0].index);
    updateAudio();
  } catch (error) {
    errorBox.textContent = error.message || String(error);
    downloadButton.disabled = true;
  }
}

videoSelect.addEventListener("change", updateAudio);
document.getElementById("cancel").addEventListener("click", () => window.close());
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  if (videoChoices.length > 1 && videoSelect.value === "") {
    errorBox.textContent = "Bitte eine Auflösung auswählen.";
    return;
  }
  if (visibleAudio().length > 1 && audioSelect.value === "") {
    errorBox.textContent = "Bitte eine Tonsprache auswählen.";
    return;
  }
  downloadButton.disabled = true;
  try {
    const response = await browser.runtime.sendMessage({
      type: "choice-start", token,
      videoIndex: videoSelect.value,
      audioIndex: audioSelect.value
    });
    if (!response?.started) throw new Error(response?.error || "Download konnte nicht gestartet werden.");
    window.close();
  } catch (error) {
    errorBox.textContent = error.message || String(error);
    downloadButton.disabled = false;
  }
});

load();
