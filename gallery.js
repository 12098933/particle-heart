(() => {
  const DEFAULT_PHOTOS = [
    {
      src: "./images/01-first-snow.jpg",
      thumb: "./images/thumbs/01-first-snow-thumb.jpg",
      title: "初雪",
      date: "DEC 24 · 2026",
      note: "雪落在安静的水面上，像时间特意放慢的一刻。",
      alt: "冬日湖畔雪景",
      custom: false
    },
    {
      src: "./images/02-christmas-lights.jpg",
      thumb: "./images/thumbs/02-christmas-lights-thumb.jpg",
      title: "圣诞灯火",
      date: "DEC 24 · 2026",
      note: "一串串暖光，把冬夜照成金色。",
      alt: "温暖的圣诞灯饰",
      custom: false
    },
    {
      src: "./images/03-snow-street.jpg",
      thumb: "./images/thumbs/03-snow-street-thumb.jpg",
      title: "雪夜街道",
      date: "DEC 25 · 2026",
      note: "走过被雪覆盖的街角，脚步声都变得温柔。",
      alt: "飘雪的冬夜街道",
      custom: false
    },
    {
      src: "./images/04-gift-light.jpg",
      thumb: "./images/thumbs/04-gift-light-thumb.jpg",
      title: "礼物与光",
      date: "DEC 25 · 2026",
      note: "被认真包装的不是礼物，是等待被打开的心意。",
      alt: "灯光下的圣诞礼物",
      custom: false
    },
    {
      src: "./images/05-winter-coffee.jpg",
      thumb: "./images/thumbs/05-winter-coffee-thumb.jpg",
      title: "冬日咖啡",
      date: "DEC 26 · 2026",
      note: "热气升起的时候，时间也慢了一点。",
      alt: "冬日里的热咖啡",
      custom: false
    },
    {
      src: "./images/06-heart-lights.jpg",
      thumb: "./images/thumbs/06-heart-lights-thumb.jpg",
      title: "心形灯火",
      date: "DEC 26 · 2026",
      note: "灯光把爱写成形状，藏在每一个小细节里。",
      alt: "心形暖色灯饰",
      custom: false
    }
  ];

  const DB_NAME = "particle-heart-memory";
  const DB_VERSION = 1;
  const STORE_NAME = "photos";
  const DELETED_DEFAULTS_KEY = "particle-heart-deleted-defaults";
  const MAX_USER_PHOTOS = 24;
  const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const scene = document.getElementById("scene");
  const gallery = document.getElementById("memoryGallery");
  const galleryButton = document.querySelector('[data-control="gallery"]');
  const closeButton = document.getElementById("galleryClose");
  const previousButton = document.getElementById("photoPrev");
  const nextButton = document.getElementById("photoNext");
  const photoCard = document.getElementById("photoCard");
  const photoImage = document.getElementById("galleryPhoto");
  const photoIndex = document.getElementById("photoIndex");
  const photoDate = document.getElementById("photoDate");
  const photoTitle = document.getElementById("photoTitle");
  const photoNote = document.getElementById("photoNote");
  const photoProgress = document.getElementById("photoProgress");
  const photoProgressFill = document.getElementById("photoProgressFill");
  const photoThumbs = document.getElementById("photoThumbs");
  const photoInput = document.getElementById("photoInput");
  const photoDelete = document.getElementById("photoDelete");
  const photoRestore = document.getElementById("photoRestore");
  const photoEmpty = document.getElementById("photoEmpty");
  const photoStorage = document.getElementById("photoStorage");
  const galleryStatus = document.getElementById("galleryStatus");

  function loadDeletedDefaults() {
    try {
      const values = JSON.parse(localStorage.getItem(DELETED_DEFAULTS_KEY) || "[]");
      return new Set(Array.isArray(values) ? values : []);
    } catch {
      return new Set();
    }
  }

  function saveDeletedDefaults() {
    try {
      localStorage.setItem(DELETED_DEFAULTS_KEY, JSON.stringify([...deletedDefaults]));
    } catch {
      notify("无法保存默认照片删除状态");
    }
  }

  const deletedDefaults = loadDeletedDefaults();
  let photos = DEFAULT_PHOTOS.filter((photo) => !deletedDefaults.has(photo.src));
  let userPhotos = [];
  let currentIndex = 0;
  let galleryOpen = false;
  let switchToken = 0;
  let openAnimationTimer = 0;
  let gatePulseTimer = 0;
  let databasePromise = null;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerTracking = false;
  const objectUrls = new Set();

  function notify(message) {
    window.ParticleHeart?.notify(message);
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("INDEXED_DB_UNAVAILABLE"));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("INDEXED_DB_FAILED"));
    });
    return databasePromise;
  }

  async function readStoredPhotos() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("PHOTO_READ_FAILED"));
    });
  }

  async function writeStoredPhoto(record) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("PHOTO_WRITE_FAILED"));
    });
  }

  async function deleteStoredPhoto(id) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("PHOTO_DELETE_FAILED"));
    });
  }

  function normalizeFileLabel(name) {
    return name
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .slice(0, 34) || "新的回忆";
  }

  function formatPhotoDate(timestamp) {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric"
    }).format(new Date(timestamp)).toUpperCase().replace(",", " ·");
  }

  function createUserPhoto(record) {
    const src = URL.createObjectURL(record.blob);
    const thumb = record.thumbBlob ? URL.createObjectURL(record.thumbBlob) : src;
    objectUrls.add(src);
    objectUrls.add(thumb);
    return {
      id: record.id,
      src,
      thumb,
      title: record.title || normalizeFileLabel(record.name || "新的回忆"),
      date: formatPhotoDate(record.createdAt || Date.now()),
      note: "由你添加并保存在当前浏览器本地。",
      alt: record.title || "用户添加的照片",
      custom: true,
      persistent: record.persistent !== false
    };
  }

  async function readFileAsBitmap(file) {
    if ("createImageBitmap" in window) {
      try {
        return await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        return createImageBitmap(file);
      }
    }

    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("IMAGE_DECODE_FAILED"));
      };
      image.src = url;
    });
  }

  async function preparePhotoBlob(file) {
    const hasImageExtension = /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name);
    if (!file.type.startsWith("image/") && !hasImageExtension) {
      throw new Error("NOT_AN_IMAGE");
    }
    if (file.size > MAX_SOURCE_BYTES) {
      throw new Error("IMAGE_TOO_LARGE");
    }

    const bitmap = await readFileAsBitmap(file);
    const sourceWidth = bitmap.width || bitmap.naturalWidth;
    const sourceHeight = bitmap.height || bitmap.naturalHeight;
    const scale = Math.min(1, 1600 / sourceWidth, 2000 / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#0b0708";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = 180;
    thumbCanvas.height = 225;
    const thumbContext = thumbCanvas.getContext("2d", { alpha: false });
    const thumbScale = Math.max(thumbCanvas.width / width, thumbCanvas.height / height);
    const drawWidth = width * thumbScale;
    const drawHeight = height * thumbScale;
    thumbContext.fillStyle = "#0b0708";
    thumbContext.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
    thumbContext.drawImage(
      canvas,
      (thumbCanvas.width - drawWidth) / 2,
      (thumbCanvas.height - drawHeight) / 2,
      drawWidth,
      drawHeight
    );
    bitmap.close?.();

    function encodeCanvas(targetCanvas) {
      return new Promise((resolve, reject) => {
        targetCanvas.toBlob(
          (result) => result ? resolve(result) : reject(new Error("IMAGE_ENCODE_FAILED")),
          "image/jpeg",
          targetCanvas === thumbCanvas ? 0.78 : 0.87
        );
      });
    }

    const [blob, thumbBlob] = await Promise.all([
      encodeCanvas(canvas),
      encodeCanvas(thumbCanvas)
    ]);
    return { blob, thumbBlob };
  }

  function renderThumbs() {
    photoThumbs.replaceChildren();
    photos.forEach((photo, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `photo-thumb${index === currentIndex ? " is-active" : ""}${photo.custom ? " is-custom" : ""}`;
      button.style.backgroundImage = `url("${(photo.thumb || photo.src).replaceAll('"', '\\"')}")`;
      button.setAttribute("aria-label", `查看第 ${index + 1} 张照片：${photo.title}`);
      button.title = photo.title;
      button.addEventListener("click", () => {
        switchPhoto(index, index > currentIndex ? 1 : -1);
      });
      photoThumbs.append(button);
    });

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "photo-thumb-add";
    addButton.setAttribute("aria-label", "添加自己的照片");
    addButton.title = "添加自己的照片";
    addButton.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14"></path>
      </svg>`;
    addButton.addEventListener("click", () => photoInput.click());
    photoThumbs.append(addButton);

    const activeThumb = photoThumbs.querySelector(".photo-thumb.is-active");
    if (galleryOpen && activeThumb) {
      const centeredScroll = activeThumb.offsetLeft - (photoThumbs.clientWidth - activeThumb.clientWidth) / 2;
      photoThumbs.scrollTo({ left: Math.max(0, centeredScroll), behavior: reduceMotion ? "auto" : "smooth" });
    }
  }

  function updateMeta() {
    const photo = photos[currentIndex];
    const persistentCount = userPhotos.filter((item) => item.persistent).length;
    photoRestore.disabled = deletedDefaults.size === 0;
    photoStorage.textContent = userPhotos.length
      ? `${userPhotos.length} 张自定义照片 · ${persistentCount} 张本地保存`
      : "照片保存在当前浏览器本地";

    if (!photo) {
      photoIndex.textContent = "FRAME --";
      photoDate.textContent = "NO FRAMES";
      photoTitle.textContent = "还没有照片";
      photoNote.textContent = "添加一张照片，开启你的第一段回忆。";
      photoProgress.textContent = "00 / 00";
      photoProgressFill.style.width = "0%";
      galleryStatus.textContent = "LOCAL MEMORY / 00 FRAMES";
      photoImage.removeAttribute("src");
      photoImage.alt = "";
      photoCard.classList.add("is-empty");
      photoDelete.disabled = true;
      renderThumbs();
      return;
    }

    photoCard.classList.remove("is-empty");
    photoDate.textContent = photo.date;
    photoTitle.textContent = photo.title;
    photoNote.textContent = photo.note;
    photoIndex.textContent = `FRAME ${String(currentIndex + 1).padStart(2, "0")}`;
    photoProgress.textContent = `${String(currentIndex + 1).padStart(2, "0")} / ${String(photos.length).padStart(2, "0")}`;
    photoProgressFill.style.width = `${((currentIndex + 1) / photos.length) * 100}%`;
    galleryStatus.textContent = `LOCAL MEMORY / ${String(photos.length).padStart(2, "0")} FRAMES`;
    photoDelete.disabled = false;
    renderThumbs();
  }

  async function switchPhoto(index, direction = 1, options = {}) {
    if (!photos.length) {
      updateMeta();
      return false;
    }
    const nextIndex = ((index % photos.length) + photos.length) % photos.length;
    if (!options.force && nextIndex === currentIndex) return false;

    const token = ++switchToken;
    const photo = photos[nextIndex];
    const preload = new Image();
    preload.src = photo.src;
    await preload.decode().catch(() => undefined);
    if (token !== switchToken) return false;

    currentIndex = nextIndex;
    photoImage.src = photo.src;
    photoImage.alt = photo.alt;
    updateMeta();

    const normalizedDirection = direction >= 0 ? 1 : -1;
    photoCard.animate(
      [
        {
          opacity: 0.28,
          transform: `translateX(${normalizedDirection * 34}px) rotateY(${normalizedDirection * -9}deg) scale(0.965)`
        },
        {
          opacity: 1,
          transform: "translateX(0) rotateY(0) scale(1)"
        }
      ],
      { duration: reduceMotion ? 1 : 440, easing: "cubic-bezier(0.2, 0.78, 0.2, 1)" }
    );
    window.ParticleHeart?.burst(0.46);
    return true;
  }

  function showGestureGate() {
    notify("单指捏合打开相册");
    galleryButton.classList.remove("is-denied");
    void galleryButton.offsetWidth;
    galleryButton.classList.add("is-denied");
    window.clearTimeout(gatePulseTimer);
    gatePulseTimer = window.setTimeout(() => galleryButton.classList.remove("is-denied"), 380);
  }

  function openGallery(fromGesture = false) {
    if (galleryOpen) return true;
    if (!fromGesture) {
      showGestureGate();
      return false;
    }

    galleryOpen = true;
    gallery.classList.add("is-open");
    gallery.classList.remove("is-opening");
    if (!reduceMotion) {
      void gallery.offsetWidth;
      gallery.classList.add("is-opening");
      window.clearTimeout(openAnimationTimer);
      openAnimationTimer = window.setTimeout(() => gallery.classList.remove("is-opening"), 1050);
    }
    gallery.setAttribute("aria-hidden", "false");
    gallery.removeAttribute("inert");
    scene.classList.add("gallery-open");
    galleryButton.classList.add("is-active");
    galleryButton.classList.remove("is-locked");
    galleryButton.setAttribute("aria-pressed", "true");
    galleryButton.setAttribute("aria-label", "关闭回忆相册");
    galleryButton.title = "关闭回忆相册";
    window.ParticleHeart?.burst(0.72);
    closeButton.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const activeThumb = photoThumbs.querySelector(".photo-thumb.is-active");
      if (!activeThumb) return;
      const centeredScroll = activeThumb.offsetLeft - (photoThumbs.clientWidth - activeThumb.clientWidth) / 2;
      photoThumbs.scrollTo({ left: Math.max(0, centeredScroll), behavior: reduceMotion ? "auto" : "smooth" });
    });
    return true;
  }

  function closeGallery() {
    if (!galleryOpen) return;
    galleryOpen = false;
    window.clearTimeout(openAnimationTimer);
    gallery.classList.remove("is-opening");
    gallery.classList.remove("is-open");
    gallery.setAttribute("aria-hidden", "true");
    gallery.setAttribute("inert", "");
    scene.classList.remove("gallery-open");
    galleryButton.classList.remove("is-active");
    galleryButton.classList.add("is-locked");
    galleryButton.setAttribute("aria-pressed", "false");
    galleryButton.setAttribute("aria-label", "单指捏合打开回忆相册");
    galleryButton.title = "单指捏合打开回忆相册";
    galleryPhoto.style.transform = "scale(1)";
    galleryButton.focus({ preventScroll: true });
  }

  function toggleGallery(fromGesture = false) {
    if (galleryOpen) {
      closeGallery();
      return false;
    }
    if (!fromGesture) {
      showGestureGate();
      return false;
    } else {
      openGallery(true);
    }
    return galleryOpen;
  }

  async function loadUserPhotos() {
    try {
      const records = await readStoredPhotos();
      userPhotos = records
        .filter((record) => record?.blob)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map(createUserPhoto);
      photos = [
        ...DEFAULT_PHOTOS.filter((photo) => !deletedDefaults.has(photo.src)),
        ...userPhotos
      ];
      currentIndex = Math.min(currentIndex, Math.max(0, photos.length - 1));
      updateMeta();
    } catch {
      photoStorage.textContent = "当前浏览器无法持久保存新增照片";
    }
  }

  async function handleFiles(fileList) {
    const files = [...fileList].filter((file) =>
      file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name)
    );
    if (!files.length) {
      notify("请选择图片文件");
      return;
    }

    const availableSlots = Math.max(0, MAX_USER_PHOTOS - userPhotos.length);
    if (!availableSlots) {
      notify("自定义照片已达到上限");
      return;
    }

    const selectedFiles = files.slice(0, availableSlots);
    const added = [];
    let addedInSessionOnly = false;
    for (const file of selectedFiles) {
      try {
        const { blob, thumbBlob } = await preparePhotoBlob(file);
        const record = {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          name: file.name,
          title: normalizeFileLabel(file.name),
          createdAt: Date.now(),
          blob,
          thumbBlob
        };
        let persistent = true;
        try {
          await writeStoredPhoto(record);
        } catch {
          persistent = false;
          addedInSessionOnly = true;
        }
        const photo = createUserPhoto({ ...record, persistent });
        userPhotos.push(photo);
        photos.push(photo);
        added.push(photo);
      } catch (error) {
        if (error?.message === "IMAGE_TOO_LARGE") {
          notify(`${file.name} 超过 24MB，已跳过`);
        } else {
          notify(`${file.name} 无法读取，已跳过`);
        }
      }
    }

    if (added.length) {
      await switchPhoto(photos.length - 1, 1, { force: true });
      notify(addedInSessionOnly ? `已添加 ${added.length} 张照片（仅本次有效）` : `已添加 ${added.length} 张本地照片`);
    }
  }

  async function removeCurrentPhoto() {
    const photo = photos[currentIndex];
    if (!photo) return;
    try {
      if (photo.custom) {
        if (photo.persistent) await deleteStoredPhoto(photo.id);
      } else {
        deletedDefaults.add(photo.src);
        saveDeletedDefaults();
      }
      const urlIndex = photos.indexOf(photo);
      const userIndex = userPhotos.indexOf(photo);
      if (userIndex >= 0) userPhotos.splice(userIndex, 1);
      if (urlIndex >= 0) photos.splice(urlIndex, 1);
      if (photo.custom && objectUrls.has(photo.src)) {
        URL.revokeObjectURL(photo.src);
        objectUrls.delete(photo.src);
      }
      if (photo.custom && photo.thumb !== photo.src && objectUrls.has(photo.thumb)) {
        URL.revokeObjectURL(photo.thumb);
        objectUrls.delete(photo.thumb);
      }
      currentIndex = Math.max(0, Math.min(currentIndex, photos.length - 1));
      if (photos.length) {
        await switchPhoto(currentIndex, -1, { force: true });
      } else {
        updateMeta();
      }
      notify("已从本地相册移除");
    } catch {
      notify("照片移除失败");
    }
  }

  async function restoreDefaultPhotos() {
    if (!deletedDefaults.size) return;
    deletedDefaults.clear();
    saveDeletedDefaults();
    photos = [...DEFAULT_PHOTOS, ...userPhotos];
    currentIndex = 0;
    await switchPhoto(0, 1, { force: true });
    notify("默认照片已恢复");
  }

  galleryButton?.addEventListener("click", () => {
    if (galleryOpen) {
      closeGallery();
    } else {
      showGestureGate();
    }
  });
  closeButton.addEventListener("click", closeGallery);
  previousButton.addEventListener("click", () => switchPhoto(currentIndex - 1, -1));
  nextButton.addEventListener("click", () => switchPhoto(currentIndex + 1, 1));
  photoDelete.addEventListener("click", removeCurrentPhoto);
  photoRestore.addEventListener("click", restoreDefaultPhotos);
  photoInput.addEventListener("change", async () => {
    await handleFiles(photoInput.files);
    photoInput.value = "";
  });

  photoCard.addEventListener("pointerdown", (event) => {
    pointerTracking = true;
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    photoCard.setPointerCapture(event.pointerId);
  });

  photoCard.addEventListener("pointerup", (event) => {
    if (!pointerTracking) return;
    pointerTracking = false;
    const deltaX = event.clientX - pointerStartX;
    const deltaY = event.clientY - pointerStartY;
    if (Math.abs(deltaX) > 36 && Math.abs(deltaX) > Math.abs(deltaY)) {
      switchPhoto(currentIndex + (deltaX < 0 ? 1 : -1), deltaX < 0 ? 1 : -1);
    }
  });

  photoCard.addEventListener("pointercancel", () => {
    pointerTracking = false;
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    gallery.addEventListener(eventName, (event) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      photoCard.style.borderColor = "#ffc66b";
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    gallery.addEventListener(eventName, (event) => {
      photoCard.style.borderColor = "";
      if (eventName === "dragleave" && gallery.contains(event.relatedTarget)) return;
      event.preventDefault();
    });
  });

  gallery.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) {
      handleFiles(event.dataTransfer.files);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!galleryOpen) return;
    if (event.key === "Escape") {
      closeGallery();
    } else if (event.key === "ArrowLeft") {
      switchPhoto(currentIndex - 1, -1);
    } else if (event.key === "ArrowRight") {
      switchPhoto(currentIndex + 1, 1);
    }
  });

  window.addEventListener("beforeunload", () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  });

  window.ParticleGallery = Object.freeze({
    open: () => {
      showGestureGate();
      return false;
    },
    close: closeGallery,
    toggle: () => {
      showGestureGate();
      return false;
    },
    toggleByGesture: () => toggleGallery(true),
    isOpen: () => galleryOpen,
    next: () => switchPhoto(currentIndex + 1, 1),
    previous: () => switchPhoto(currentIndex - 1, -1),
    switchByGesture(direction) {
      if (!galleryOpen) {
        showGestureGate();
        return false;
      }
      return switchPhoto(currentIndex + (direction < 0 ? -1 : 1), direction < 0 ? -1 : 1);
    },
    setPinch(amount) {
      const scale = 1 + Math.max(0, Math.min(1, amount)) * 0.16;
      galleryPhoto.style.transform = `scale(${scale})`;
    },
    count: () => photos.length,
    current: () => photos[currentIndex]
  });

  updateMeta();
  loadUserPhotos();
})();
