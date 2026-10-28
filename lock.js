(() => {
  const lockScreen = document.getElementById("lockScreen");
  const lockPanel = document.getElementById("lockPanel");
  const pinDots = [...document.querySelectorAll(".pin-dot")];
  const lockMessage = document.getElementById("lockMessage");
  const scene = document.getElementById("scene");
  const digitButtons = [...document.querySelectorAll("[data-digit]")];
  const clearButton = document.getElementById("lockClear");
  const backspaceButton = document.getElementById("lockBackspace");
  const accessCode = ["0", "6", "1", "2", "0", "9"];

  let entered = "";
  let locked = true;
  let verifying = false;
  let submitTimer = 0;

  function updateDots() {
    pinDots.forEach((dot, index) => {
      dot.classList.toggle("is-filled", index < entered.length);
    });
    pinDots[0].parentElement.setAttribute("aria-label", `已输入 ${entered.length} 位，共 6 位`);
  }

  function setMessage(message, isError = false) {
    lockMessage.textContent = message;
    lockMessage.classList.toggle("is-error", isError);
  }

  function addDigit(digit) {
    if (!locked || verifying || entered.length >= accessCode.length) return;
    entered += digit;
    updateDots();
    setMessage("ACCESS CODE RECEIVED");
    if (entered.length === accessCode.length) {
      window.clearTimeout(submitTimer);
      submitTimer = window.setTimeout(attemptUnlock, 130);
    }
  }

  function removeDigit() {
    if (!locked || verifying || !entered.length) return;
    entered = entered.slice(0, -1);
    updateDots();
    setMessage("LOCAL ACCESS ONLY");
  }

  function clearCode() {
    if (!locked || verifying) return;
    entered = "";
    updateDots();
    setMessage("LOCAL ACCESS ONLY");
  }

  function showWrongCode() {
    verifying = true;
    lockPanel.classList.remove("is-error");
    void lockPanel.offsetWidth;
    lockPanel.classList.add("is-error");
    setMessage("密码错误，请重新输入", true);
    window.setTimeout(() => {
      entered = "";
      updateDots();
      verifying = false;
      lockPanel.classList.remove("is-error");
      setMessage("LOCAL ACCESS ONLY");
    }, 460);
  }

  function unlock() {
    verifying = true;
    setMessage("ACCESS GRANTED");
    lockScreen.classList.add("is-unlocking");
    window.setTimeout(() => {
      locked = false;
      document.body.classList.add("is-unlocked");
      lockScreen.classList.add("is-unlocked");
      lockScreen.setAttribute("aria-hidden", "true");
      scene.removeAttribute("inert");
      scene.setAttribute("aria-hidden", "false");
      window.dispatchEvent(new CustomEvent("particleheart:unlocked"));
    }, 920);
  }

  function attemptUnlock() {
    if (!locked || verifying) return;
    if (entered.length !== accessCode.length) {
      setMessage("请输入六位密码", true);
      return;
    }
    if (entered === accessCode.join("")) {
      unlock();
    } else {
      showWrongCode();
    }
  }

  digitButtons.forEach((button) => {
    button.addEventListener("click", () => addDigit(button.dataset.digit));
  });
  backspaceButton.addEventListener("click", removeDigit);
  clearButton.addEventListener("click", clearCode);

  document.addEventListener("keydown", (event) => {
    if (!locked) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      addDigit(event.key);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      event.stopImmediatePropagation();
      removeDigit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearCode();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopImmediatePropagation();
      attemptUnlock();
    }
  }, true);

  lockPanel.setAttribute("tabindex", "-1");
  lockPanel.focus({ preventScroll: true });
  updateDots();
})();
