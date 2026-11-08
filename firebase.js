// Vatra - Firebase connector.
// Signs the device in anonymously, asks once for the family code,
// then hands the app a Firestore database (same API the app already uses).
(function () {
  var config = {
    apiKey: "AIzaSyBdDVmnGsIglBPmhjsw2If4nb4A-xATHU4",
    authDomain: "vatra-5c23f.firebaseapp.com",
    projectId: "vatra-5c23f",
    storageBucket: "vatra-5c23f.firebasestorage.app",
    messagingSenderId: "207660634182",
    appId: "1:207660634182:web:a07562310b64b96eb1fa47"
  };

  var db = null;

  function joinScreen(uid) {
    return new Promise(function (resolve) {
      var wrap = document.createElement("div");
      wrap.id = "vatra-join";
      wrap.innerHTML =
        '<div class="vj-card">' +
        '<div class="vj-title">🔥 Vatra</div>' +
        '<div class="vj-sub">Enter the family code to join.</div>' +
        '<input id="vj-code" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Family code">' +
        '<button id="vj-go">Join</button>' +
        '<div id="vj-err" class="vj-err"></div>' +
        "</div>";
      document.body.appendChild(wrap);
      var input = wrap.querySelector("#vj-code");
      var err = wrap.querySelector("#vj-err");
      var btn = wrap.querySelector("#vj-go");
      input.focus();
      function go() {
        var code = input.value.trim();
        if (!code) return;
        btn.disabled = true; err.textContent = "";
        db.doc("members/" + uid).set({ code: code, at: new Date().toISOString(), device: navigator.userAgent.slice(0, 120) })
          .then(function () { wrap.remove(); resolve(); })
          .catch(function () { btn.disabled = false; err.textContent = "That code didn't work. Try again."; input.select(); });
      }
      btn.onclick = go;
      input.onkeydown = function (e) { if (e.key === "Enter") go(); };
    });
  }

  window.vatraReady = new Promise(function (resolve) {
    try {
      firebase.initializeApp(config);
      db = firebase.firestore();
      db.settings({ ignoreUndefinedProperties: true, merge: true });
      db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
      var auth = firebase.auth();
      var unsub = auth.onAuthStateChanged(function (user) {
        if (!user) { auth.signInAnonymously().catch(function () { resolve(); }); return; }
        unsub();
        db.doc("members/" + user.uid).get()
          .then(function (s) { return s.exists ? null : joinScreen(user.uid); })
          .catch(function () { return joinScreen(user.uid); })
          .then(function () { resolve(); });
      });
    } catch (e) { db = null; resolve(); }
  });

  window.claude = { use: function () { return window.vatraReady.then(function () { return db; }); } };
})();
