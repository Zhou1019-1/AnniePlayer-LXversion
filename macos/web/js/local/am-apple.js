/**
 * Apple Music 独立板块
 * ─────────────────────────────────────────────────────────────
 * ⚠️ 2026-10-22 新建（用户要求）：
 *   Apple Music 需要登录 Apple ID 才能播放（ALAC 无损也依赖登录态），
 *   所以从「在线音乐」的平台列表里独立出来，做成专属页面：
 *     · 登录管理（Apple ID + 两步验证 + 区域）
 *     · 搜索（歌曲/专辑/艺人）
 *     · 播放（ALAC 无损）
 *
 * 依赖：
 *   window.mine.amLoginStatus()  → {loggedIn, env, vmName, phase}
 *   window.mine.vmLogin({email, password, code?}) → {ok, needCode?, message?}
 *   window.mine.vmLogout() → {ok}
 *
 *   注：vm* 走 VM 内常驻 HTTP 服务（快，14~39ms）；旧 am* 接口是 QEMU 架构遗留。
 *   window.mine.streamSearch({provider:'alac', ...}) / streamSongUrl
 */
(function () {
  var AM = window.__annieAMInternal;
  if (!AM) { console.warn('[apple] AM 未就绪'); return; }
  var el = AM.el, esc = AM.esc, fmtTime = AM.fmtTime;

  var ST = {
    st: null,           // 登录状态
    checking: false,
    kw: '',
    results: [],
    searching: false,
    loadingLogin: false,
    needCode: false,
    error: '',
    token: '',
  };

  function refresh() {
    try { AM.renderView(); } catch (e) { }
  }

  function loadStatus(force) {
    if (ST.checking) return;
    // ⚠️ 2026-10-22：已有状态且未强制刷新时，直接用缓存（避免每次切页都查一次）
    if (!force && ST.st && ST.lastCheck && (Date.now() - ST.lastCheck < 30000)) {
      return;
    }
    ST.checking = true;
    // ⚠️ 2026-10-22：改成 VM 常驻服务接口（vmLoginStatus）。
    //    原来这里调的是旧 QEMU 接口 amLoginStatus —— 那个接口在 VM 架构下
    //    永远返回未登录/超时，导致 ST.st 一直为 null，界面卡在
    //    「正在读取登录状态…」，验证码输入框永远出不来。
    // ⚠️ 2026-10-23：状态查询改走 VM 架构（与 vmLogin 同一登录源）
    window.mine.vmLoginStatus().then(function (st) {
      ST.st = st || {};
      ST.checking = false;
      ST.lastCheck = Date.now();
      if (st && st.loggedIn) ST.forceLogin = false;
      ST.token = '';
      refresh();
    }).catch(function () {
      ST.st = { loggedIn: false };
      ST.checking = false;
      refresh();
    });
  }

  /* ---------------- 登录页 ---------------- */
  function renderLogin(c) {
    c.innerHTML = '';
    var page = el('div');
    page.style.cssText = 'display:flex;flex-direction:column;align-items:center;width:100%;padding-top:8px';

    var title = el('div', 'am-view-h', 'Apple Music');
    title.style.cssText = 'margin:0 0 6px;text-align:center';
    page.appendChild(title);

    if (ST.error) {
      var warn = el('div');
      warn.style.cssText = 'text-align:center;color:#ff6b6b;font-size:13px;margin-bottom:12px;max-width:440px;line-height:1.6';
      warn.textContent = ST.error;
      page.appendChild(warn);
    }

    var desc = el('div', 'am-c-dim');
    desc.textContent = '播放 Apple Music 的 ALAC 无损需要登录 Apple ID。凭据仅保存在本机。';
    desc.style.cssText = 'text-align:center;margin-bottom:18px;font-size:13px;max-width:440px;line-height:1.6';
    page.appendChild(desc);

    var card = el('div');
    card.style.cssText = 'width:min(460px,100%);display:flex;flex-direction:column;gap:10px;' +
      'padding:22px 24px;border-radius:14px;' +
      'background:color-mix(in srgb, var(--am-bg) 82%, transparent);' +
      'border:1px solid var(--am-sep);box-shadow:0 10px 30px -18px rgba(0,0,0,.4)';

    var head = el('div');
    head.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:2px';
    head.textContent = ST.needCode ? '输入两步验证码' : 'Apple ID 登录';
    card.appendChild(head);

    if (ST.needCode) {
      var inpC = document.createElement('input');
      inpC.className = 'am-st-input';
      inpC.placeholder = '6 位验证码（来自你的 Apple 设备）';
      inpC.style.width = '100%';
      inpC.style.letterSpacing = '4px';
      inpC.style.textAlign = 'center';
      inpC.style.fontSize = '18px';
      card.appendChild(inpC);
      var codeStatus = el('div');
      codeStatus.id = 'am-am-code-status';
      codeStatus.style.cssText = 'font-size:12px;min-height:18px;color:#4a9eff';
      card.appendChild(codeStatus);
      inpC.focus();
      var bCode = el('button', 'am-btn am-btn-accent', '提交验证码');
      bCode.onclick = function () {
        var code = inpC.value.trim();
        if (!code) { ST.error = '请输入验证码'; refresh(); return; }
        // ⚠️ 2026-10-22：验证码提交也不能重建页面（否则验证码被清空）
        var codeStatus = document.getElementById('am-am-code-status');
        if (codeStatus) { codeStatus.textContent = '验证中…'; codeStatus.style.color = '#4a9eff'; }
        bCode.disabled = true;
        bCode.textContent = '验证中…';
        // ⚠️ 2026-10-22 关键修复「提交验证码后没反应」：
        //    vmLogin 带 code 调用**本身就会阻塞到最终结果**（成功/验证码错/失败），
        //    原来这里把返回值忽略了，进去做 60 秒轮询 → 界面卡在「验证中…」没反馈。
        //    现在直接用返回值判断，立即给出结果。
        // ⚠️ 2026-10-23：验证码提交也走 vmLogin（VM 架构两阶段登录）
        window.mine.vmLogin({ email: ST.lastEmail || '', password: ST.lastPassword || '', code: code }).then(function (r) {
          if (r && r.ok) {
            // ⚠️ 2026-10-23：amLoginCode 返回 ok 只表示「验证码已提交」，
            //    此时 QEMU 会带验证码重启并重登，需要几十秒。
            //    这里轮询 amLoginStatus 直到真正 loggedIn。
            ST.loadingLogin = true;
            var tries = 0;
            var timer = setInterval(function () {
              tries++;
              window.mine.vmLoginStatus().then(function (st) {
                var cs2 = document.getElementById('am-am-code-status');
                if (st && st.loggedIn) {
                  clearInterval(timer);
                  ST.needCode = false; ST.error = ''; ST.loadingLogin = false;
                  ST.forceLogin = false;
                  ST.st = st; ST.lastCheck = Date.now();
                  refresh();
                  return;
                }
                if (tries > 60) {   // 90 秒
                  clearInterval(timer);
                  ST.loadingLogin = false;
                  if (cs2) {
                    cs2.textContent = '验证超时：QEMU 登录没有完成，请重试（可能验证码已过期）';
                    cs2.style.color = '#ff6b6b';
                  }
                  bCode.disabled = false;
                  bCode.textContent = '重新提交验证码';
                  return;
                }
                if (cs2) cs2.textContent = '验证中…（QEMU 重启登录，约 ' + (tries * 1.5).toFixed(0) + 's）';
              }).catch(function () { });
            }, 1500);
            return;
          }
          // 失败 / 验证码错误：原地显示原因，保留验证码输入方便重试
          ST.loadingLogin = false;
          var cs = document.getElementById('am-am-code-status');
          var msg = (r && (r.message || r.error)) || '验证失败';
          if (cs) {
            cs.textContent = msg;
            cs.style.color = '#ff6b6b';
            cs.style.whiteSpace = 'pre-wrap';
            cs.style.textAlign = 'left';
            cs.style.background = 'color-mix(in srgb, #ff6b6b 8%, transparent)';
            cs.style.borderRadius = '8px';
            cs.style.padding = '10px 12px';
            cs.style.maxHeight = '220px';
            cs.style.overflowY = 'auto';
          }
          if (r && r.needCode) {
            // 还是需要验证码 → 保持验证码页，让用户重新输入
            ST.needCode = true;
          }
          bCode.disabled = false;
          bCode.textContent = '重新提交验证码';
        }).catch(function (e) {
          ST.error = '提交失败：' + (e.message || e);
          refresh();
        });
      };
      inpC.onkeydown = function (e) { if (e.key === 'Enter') bCode.click(); };
      card.appendChild(bCode);
      var bBack = el('button', 'am-btn', '返回重新登录');
      bBack.onclick = function () { ST.needCode = false; ST.error = ''; refresh(); };
      card.appendChild(bBack);
    } else {
      // ⚠️ 2026-10-23 关键（彻底修复「输入自己的账号却登录陌生账号」）：
      //   WKWebView 的系统密码自动填充会反复把旧账号写进 <input>，
      //   连 autocomplete=off + input 事件检测都压不住。
      //   改用 contenteditable 内容可编辑区 —— 系统自动填充**不会**作用于它，
      //   输入框里的内容 100% 是用户亲手敲的。
      var inpE = document.createElement('div');
      inpE.setAttribute('contenteditable', 'true');
      inpE.setAttribute('data-placeholder', 'Apple ID（邮箱）');
      inpE.className = 'am-st-input am-editable';
      inpE.style.cssText = 'width:100%;min-height:38px;line-height:22px;padding:8px 10px;' +
        'box-sizing:border-box;outline:none;cursor:text;white-space:nowrap;overflow-x:auto';
      inpE.__userTyped = false;
      inpE.addEventListener('input', function () { inpE.__userTyped = true; }, true);
      // ⚠️ 2026-10-23 关键修复「输入陌生账号，登录的仍是旧账号」：
      //   WKWebView 的密码自动填充（macOS 自动填充）会在提交/聚焦时把输入框
      //   内容替换成已保存的旧 Apple ID —— 用户以为自己输了新账号，实际 value 被覆盖。
      //   这里关闭所有自动填充/自动纠正，保证 value 就是用户亲手输入的内容。
      inpE.setAttribute('autocomplete', 'off');
      inpE.setAttribute('autocorrect', 'off');
      inpE.setAttribute('autocapitalize', 'off');
      inpE.setAttribute('spellcheck', 'false');
      inpE.name = 'am-login-email-' + Date.now();
      // 记录用户每次输入，和提交时的值对比（诊断自动填充覆盖）
      inpE.addEventListener('input', function () {
        inpE.__userTyped = true;
        try { console.log('[AM] 输入变化 email=' + inpE.textContent.trim()); } catch (e) { }
        var live = document.getElementById('am-email-live');
        if (live) {
          var v = inpE.textContent.trim();
          live.textContent = v ? ('当前输入：' + (v.length > 8 ? v.slice(0, 3) + '***' + v.slice(-14) : v)) : '当前输入：（空）';
          live.style.color = v ? '#4a9eff' : '#888';
        }
      });
      card.appendChild(inpE);
      // ⚠️ 2026-10-23：实时显示输入框里的账号（用户能直接看到实际值，
      //   杜绝「以为输了新账号、实际还是旧账号（被自动填充覆盖）」）
      var liveLine = el('div');
      liveLine.id = 'am-email-live';
      liveLine.style.cssText = 'font-size:11px;color:#888;padding:2px 2px 0;text-align:left;min-height:15px';
      liveLine.textContent = '当前输入：（空）';
      card.appendChild(liveLine);
      var inpP = document.createElement('div');
      inpP.setAttribute('contenteditable', 'true');
      inpP.setAttribute('data-placeholder', '密码');
      inpP.className = 'am-st-input am-editable am-editable-pw';
      inpP.style.cssText = 'width:100%;min-height:38px;line-height:22px;padding:8px 10px;' +
        'box-sizing:border-box;outline:none;cursor:text;white-space:nowrap;overflow-x:auto;' +
        '-webkit-text-security:disc';
      inpP.addEventListener('input', function () {
        try { console.log('[AM] 输入变化 密码长度=' + inpP.textContent.length); } catch (e) { }
      });
      card.appendChild(inpP);
      // 登录状态提示（原地更新，不重建页面）
      var statusLine = el('div');
      statusLine.id = 'am-am-login-status';
      statusLine.style.cssText = 'font-size:12px;min-height:18px;color:#4a9eff;' +
        'white-space:pre-wrap;line-height:1.6;max-height:260px;overflow-y:auto;' +
        'text-align:left;padding:2px 0';
      statusLine.textContent = ST.error || '';
      if (ST.error && ST.error.indexOf('登录失败') >= 0) statusLine.style.color = '#ff6b6b';
      card.appendChild(statusLine);

      var submit = function () {
        var em = inpE.textContent.trim(), pw = inpP.textContent;
        // ⚠️ 2026-10-23 诊断：打印实际提交的账号（脱敏），
        //   排查「用户以为输入了陌生账号、后端却收到旧账号」的问题。
        try {
          var masked = em.length > 8 ? (em.slice(0, 3) + '***' + em.slice(-8)) : em;
          console.log('[AM] 提交登录账号=' + masked + ' 密码长度=' + pw.length);
        } catch (eD) { }
        if (!em || !pw) { ST.error = '请填写 Apple ID 和密码'; refresh(); return; }
        // ⚠️ 2026-10-22 修复「点登录后输入框被清空」：
        //    原来这里调 refresh() → renderLogin() 里 c.innerHTML='' 重建整个页面
        //    → 用户刚输入的账号密码全没了，而且失败后要重新输入。
        //    现在只在原地更新状态文字，不动输入框。
        // ⚠️ 2026-10-23（用户要求「绝不登录错账号」）：两步确认。
        //   ⚠️ 关键：确认阶段**不能 refresh()** —— 那样会重建登录页、
        //   把用户刚输入的账号密码清空（用户反馈「确认环节还得重新输入一次」）。
        //   这里只原地更新状态文字 + 按钮文案，输入框完全保留。
        if (ST.confirmEmail !== em) {
          ST.confirmEmail = em;
          ST.confirmPassword = pw;
          var cmsg = (em.length > 8 ? em.slice(0, 3) + '***' + em.slice(-14) : em);
          var stEl0 = document.getElementById('am-am-login-status');
          if (stEl0) {
            stEl0.textContent = '即将登录：' + cmsg + '\n请再点一次「确认登录」按钮（账号不对就先清空输入框重新输入）';
            stEl0.style.color = '#ffb020';
          }
          bLogin.textContent = '确认登录';
          return;
        }
        ST.confirmEmail = null;
        ST.lastEmail = em; ST.lastPassword = pw;   // 验证码阶段要用
        ST.loadingLogin = true;
        // ⚠️ 2026-10-23（用户要求）：确认登录后**锁定输入框**，用快照提交，
        //   直到出结果才解锁。这样提交期间输入框内容不可能被系统/自动填充改动，
        //   保证提交的账号 = 用户确认时看到的账号。
        try {
          inpE.setAttribute('contenteditable', 'false');
          inpP.setAttribute('contenteditable', 'false');
          inpE.style.opacity = '0.6'; inpP.style.opacity = '0.6';
          inpE.style.pointerEvents = 'none'; inpP.style.pointerEvents = 'none';
        } catch (eLock) { }
        var unlockInputs = function () {
          try {
            inpE.setAttribute('contenteditable', 'true');
            inpP.setAttribute('contenteditable', 'true');
            inpE.style.opacity = '1'; inpP.style.opacity = '1';
            inpE.style.pointerEvents = ''; inpP.style.pointerEvents = '';
          } catch (eLB) { }
        };
        var statusEl = document.getElementById('am-am-login-status');
        if (statusEl) {
          // ⚠️ 2026-10-23：把「实际提交的账号」显示出来，用户能直接确认
          //   自己输入的账号有没有被自动填充/缓存覆盖。
          var shownMask = em.length > 8 ? (em.slice(0, 3) + '***' + em.slice(-10)) : em;
          statusEl.textContent = '登录中（提交账号：' + shownMask + '，首次启动需要几十秒初始化环境）…';
          statusEl.style.cssText = 'font-size:12px;min-height:18px;color:#4a9eff;' +
            'white-space:pre-wrap;line-height:1.6;max-height:260px;overflow-y:auto;' +
            'text-align:left;padding:2px 0';
        }
        bLogin.disabled = true;
        bLogin.textContent = '登录中…（输入框已锁定）';
        // ⚠️ 2026-10-22：改用 Linux VM 里的原生 wrapper 登录
        //    （QEMU 双层模拟被 Apple 风控拒绝，见 LinuxWrapperLogin.swift 注释）
        // ⚠️ 2026-10-23 重要修复（用户报「有双重验证的账号进 App 后收不到验证码」）：
        //   原来登录走 amLogin（QEMU legacy 架构）—— 它不处理 Apple 的 2FA 挑战，
        //   guest 永远返回 2FA:false + login successful，验证码环节根本不触发。
        //   改用 vmLogin（VM 内 am-login-server，官方两阶段 2FA 流程）：
        //     第 1 次 {email,password} → needCode
        //     第 2 次 {email,password,code} → success
        window.mine.vmLogin({ email: em, password: pw }).then(function (r) {
          ST.loadingLogin = false;
          unlockInputs();
          if (r && r.ok) {
            // ⚠️ 2026-10-23 关键修复「登录成功但界面不切换」：
            //    forceLogin 是「重新登录」按钮设置的，只有 loadStatus 的异步回调
            //    会重置它；但 loadStatus 有 30 秒缓存，命中缓存就直接 return，
            //    forceLogin 一直是 true → render() 永远走登录页。
            //    这里登录成功后立即重置，并乐观更新状态 + 强制刷新。
            ST.error = ''; ST.needCode = false;
            ST.forceLogin = false;
            ST.st = { loggedIn: true };
            ST.lastCheck = Date.now();
            refresh();
            loadStatus(true);
          } else if (r && r.needCode) {
            ST.needCode = true; ST.error = r.message || '需要两步验证码'; refresh();
          } else {
            // 失败：原地显示错误，保留用户输入
            ST.loadingLogin = false;
            var msg = (r && (r.error || r.message)) || '登录失败';
            if (statusEl) { statusEl.textContent = msg; statusEl.style.color = '#ff6b6b'; }
            bLogin.disabled = false;
            bLogin.textContent = '重新登录';
          }
        }).catch(function (e) {
          ST.loadingLogin = false;
          unlockInputs();
          var msg = '登录失败：' + (e.message || e);
          if (statusEl) { statusEl.textContent = msg; statusEl.style.color = '#ff6b6b'; }
          bLogin.disabled = false;
          bLogin.textContent = '重新登录';
        });
      };
      inpP.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
      // ⚠️ 2026-10-24（用户要求）：contenteditable 默认回车会插入 <div>/<br> 换行，
      //   账号/密码框必须禁止换行。Enter 在账号框跳密码框，密码框提交。
      function noNewline(el, onEnter) {
        el.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') { e.preventDefault(); if (onEnter) onEnter(); return; }
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
            // 粘贴多行时也清洗
          }
        });
        el.addEventListener('paste', function (e) {
          e.preventDefault();
          var txt = (e.clipboardData || window.clipboardData).getData('text') || '';
          txt = txt.replace(/[\r\n]+/g, '');
          var sel = window.getSelection();
          if (!sel.rangeCount) return;
          var r = sel.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(txt));
          r.collapse(false);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      noNewline(inpE, function () { inpP.focus(); });
      noNewline(inpP, function () { if (typeof submit === 'function') submit(); });
      var bLogin = el('button', 'am-btn am-btn-accent', '登录');
      bLogin.onclick = submit;
      card.appendChild(bLogin);
    }
    page.appendChild(card);

    // 备选：直接填 token
    var card2 = el('div');
    card2.style.cssText = 'width:min(460px,100%);display:flex;flex-direction:column;gap:8px;' +
      'padding:16px 20px;border-radius:12px;margin-top:12px;' +
      'background:color-mix(in srgb, var(--am-bg) 72%, transparent);' +
      'border:1px solid var(--am-sep)';
    var h2 = el('div');
    h2.style.cssText = 'font-size:12px;opacity:.8;margin-bottom:2px';
    h2.textContent = '或直接填入 Apple Music Media-User-Token（已有 token 的话）';
    card2.appendChild(h2);
    var inpTok = document.createElement('input');
    inpTok.className = 'am-st-input';
    inpTok.placeholder = '粘贴 token';
    inpTok.value = ST.token || '';
    inpTok.style.width = '100%';
    card2.appendChild(inpTok);
    var bSaveTok = el('button', 'am-btn', '保存 Token');
    bSaveTok.onclick = function () {
      var tk = inpTok.value.trim();
      window.mine.amSetToken(tk).then(function () {
        ST.token = tk; ST.error = '';
        loadStatus();
      });
    };
    card2.appendChild(bSaveTok);
    page.appendChild(card2);

    c.appendChild(page);
  }

  /* ---------------- 搜索 + 结果页 ---------------- */
  function renderMain(c) {
    c.innerHTML = '';
    var st = ST.st || {};

    // 头部
    var head = el('div');
    head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap';
    head.appendChild(el('div', 'am-view-h', 'Apple Music'));
    var badge = el('span', 'am-c-dim');
    badge.textContent = st.loggedIn
      ? ('已登录' + (st.regions && st.regions.length ? ' · ' + st.regions.join('/') : ''))
      : '未登录';
    head.appendChild(badge);
    if (ST.token) {
      var tl = el('span', 'am-c-dim');
      tl.style.cssText = 'font-size:11px;opacity:.6';
      tl.textContent = 'Token: ' + ST.token.slice(0, 8) + '…';
      head.appendChild(tl);
    }
    // ⚠️ 2026-10-22：登录页可达性（用户要求「AM 也得做登录界面」）
    var bRelogin = el('button', 'am-btn', '重新登录');
    bRelogin.title = '打开登录页面（可换账号或重新填 Token）';
    bRelogin.onclick = function () {
      ST.forceLogin = true;
      ST.error = '';
      refresh();
    };
    head.appendChild(bRelogin);
    var bOut = el('button', 'am-btn', '退出登录');
    bOut.onclick = function () {
      // ⚠️ 2026-10-22：退出登录改用 VM 服务接口
      // ⚠️ 2026-10-23：退出登录改走 VM 架构（vmLogout 清理 VM 侧登录态）
      window.mine.vmLogout().then(function () {
        return window.mine.vmLoginStatus();
      }).then(function (s) {
        ST.st = s; ST.results = []; ST.token = ''; ST.forceLogin = false; refresh();
      }).catch(function () {
        ST.st = { loggedIn: false }; ST.results = []; refresh();
      });
    };
    head.appendChild(bOut);
    var bReload = el('button', 'am-btn', '刷新状态');
    bReload.onclick = function () { loadStatus(true); };
    head.appendChild(bReload);
    c.appendChild(head);

    // 搜索行
    var row = el('div', 'am-st-inputrow');
    var inp = document.createElement('input');
    inp.className = 'am-st-input';
    inp.placeholder = '搜索 Apple Music 歌曲、专辑、艺人…';
    inp.value = ST.kw || '';
    inp.onkeydown = function (e) { if (e.key === 'Enter') doSearch(inp.value.trim()); };
    row.appendChild(inp);
    var bGo = el('button', 'am-btn am-btn-accent', '搜索');
    bGo.onclick = function () { doSearch(inp.value.trim()); };
    row.appendChild(bGo);
    c.appendChild(row);

    // 状态
    if (ST.searching) {
      var s1 = el('div', 'am-empty', '搜索中…');
      c.appendChild(s1);
      return;
    }
    if (ST.error) {
      var err = el('div', 'am-empty');
      err.style.color = '#ff6b6b';
      err.textContent = ST.error;
      c.appendChild(err);
    }
    if (!ST.results.length) {
      if (ST.kw) c.appendChild(el('div', 'am-empty', '没有找到结果'));
      else c.appendChild(el('div', 'am-empty', '输入关键词搜索 Apple Music'));
      return;
    }

    // 结果表格
    var tbl = el('table', 'am-table');
    var thead = el('thead');
    var trh = el('tr');
    ['', '歌曲', '艺人', '专辑', '时长', '音质', '收藏', '链接', '下载'].forEach(function (h) {
      trh.appendChild(el('th', '', h));
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    var tbody = el('tbody');

    ST.results.forEach(function (song, i) {
      var tr = el('tr', 'am-tr');
      // 封面
      // ⚠️ 2026-10-23：加专用 class —— 通用 .am-table td:nth-child(1) 只给 5% 宽
      //   且 overflow:visible，窄窗口下 36px 封面会溢出压到「歌曲」列标题上。
      var tdCover = el('td', 'am-track-covercell');
      var hit = el('div', 'am-c-cover-hit');
      if (song.cover) {
        var img = document.createElement('img');
        img.className = 'am-c-cover';
        img.src = song.cover;
        img.alt = '';
        img.loading = 'lazy';
        img.style.cssText = 'width:36px;height:36px;border-radius:6px;object-fit:cover';
        hit.appendChild(img);
      } else {
        hit.appendChild(el('span', 'am-cover-ph', '♪'));
      }
      tdCover.appendChild(hit);
      tr.appendChild(tdCover);
      tr.appendChild(el('td', '', song.name || ''));
      tr.appendChild(el('td', '', song.artist || song.singer || ''));
      tr.appendChild(el('td', '', song.album || ''));
      var dur = song.duration || 0;
      tr.appendChild(el('td', '', dur > 0 ? fmtTime(dur > 1000 ? dur / 1000 : dur) : ''));
      var tdB = el('td');
      var b = el('span', 'am-qbadge hq', 'ALAC');
      tdB.appendChild(b);
      tr.appendChild(tdB);

      // ⚠️ 2026-10-22：补上收藏 / 复制链接 / 下载（用户要求）
      var tdFav = el('td');
      var bFav = el('button', 'am-dl-btn', '♥');
      // ⚠️ 2026-10-23 改版（用户反馈「点了没有变红」）：
      //   原来单击直接弹「收藏到在线歌单」菜单，爱心本身不变色 → 用户以为坏了。
      //   现在：单击 = 加入/取消喜爱歌曲（立即变红），右键 = 收藏到在线歌单。
      bFav.title = '单击：加入/取消喜爱 · 右键：收藏到在线歌单';
      // ⚠️ 2026-10-24（用户反馈）：补上「复制链接」。
      //   AM 曲目链接用 Apple Music 官方歌曲页（songId = adamId）。
      var bLink = el('button', 'am-dl-btn', '🔗');
      bLink.title = '复制 Apple Music 歌曲链接';
      bLink.onclick = function (e) {
        e.stopPropagation();
        var sid = song.id || song.songmid || '';
        if (!sid) { if (typeof proToast === 'function') proToast('该曲目没有可用的链接'); return; }
        var url = 'https://music.apple.com/cn/song/' + sid;
        window.mine.copyText(url).then(function () {
          if (typeof proToast === 'function') proToast('已复制：' + url);
        }).catch(function () { });
      };
      tdFav.appendChild(bLink);
      bFav.onclick = function (e) {
        e.stopPropagation();
        var isOn = bFav.classList.contains('faved');
        window.mine.toggleFavorite({ song: song }).then(function () {
          bFav.classList.toggle('faved', !isOn);
          if (typeof proToast === 'function') proToast(!isOn ? '已加入喜爱歌曲' : '已取消喜爱');
        }).catch(function () { });
      };
      bFav.oncontextmenu = function (e) {
        e.preventDefault(); e.stopPropagation();
        if (AM.openSplPicker) AM.openSplPicker(e.clientX, e.clientY, [song]);
      };
      tdFav.appendChild(bFav);
      tr.appendChild(tdFav);

      var tdShare = el('td');
      var bShare = el('button', 'am-dl-btn', '🔗');
      bShare.title = '复制 Apple Music 分享链接';
      bShare.onclick = function (e) {
        e.stopPropagation();
        var url = 'https://music.apple.com/song/' + (song.songmid || song.id || '');
        try {
          if (window.mine && window.mine.copyText) window.mine.copyText(url);
          if (typeof proToast === 'function') proToast('链接已复制：' + url);
        } catch (err) { }
      };
      tdShare.appendChild(bShare);
      tr.appendChild(tdShare);

      var tdDl = el('td');
      var bDl = el('button', 'am-dl-btn', '⬇');
      bDl.title = '下载 ALAC 到下载目录';
      bDl.onclick = function (e) {
        e.stopPropagation();
        bDl.textContent = '✓';
        setTimeout(function () { if (bDl.isConnected) bDl.textContent = '⬇'; }, 1500);
        if (window.mine && window.mine.dlAdd) {
          window.mine.dlAdd([{ provider: 'alac', quality: 'alac', song: song,
                               saveLrc: true, saveCover: true }]).catch(function () { });
          if (typeof proToast === 'function') proToast('已加入下载队列');
        }
      };
      tdDl.appendChild(bDl);
      tr.appendChild(tdDl);

      // 单击选中 / 双击播放
      tr.onclick = function () {
        var rows = c.querySelectorAll('tr.am-tr');
        for (var k = 0; k < rows.length; k++) rows[k].classList.remove('sel');
        tr.classList.add('sel');
      };
      tr.ondblclick = function () { playAt(i); };
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    c.appendChild(tbl);
  }

  function doSearch(kw) {
    if (!kw) return;
    ST.kw = kw; ST.searching = true; ST.error = ''; refresh();
    // ⚠️ 2026-10-23：改用官方 amp-api 搜索（amSearch）
    window.mine.amSearch({ keyword: kw, page: 1, limit: 30 })
      .then(function (r) {
        ST.searching = false;
        ST.results = (r && r.songs) || [];
        if (!ST.results.length) ST.error = '没有搜到结果，换个关键词试试';
        refresh();
      }).catch(function (e) {
        ST.searching = false;
        ST.error = '搜索失败：' + (e.message || e);
        refresh();
      });
  }

  function playAt(i) {
    var list = ST.results;
    if (!list[i]) return;
    var song = list[i];
    var adamId = song.adamId || song.songmid || song.id || '';
    if (!adamId) {
      if (typeof proToast === 'function') proToast('这首歌缺少 adamId，无法播放');
      return;
    }
    // ⚠️ 2026-10-23：AM 播放走 Bridge.amPlay —— 它内部完成
    //   m3u8 → ALAC 变体 → 解密模板 → 分片下载 → Temari 解密 → 组装 MP4
    //   首次播放需要 10~40 秒（下载整首），之后命中缓存秒开。
    if (typeof proToast === 'function') proToast('正在准备「' + (song.name || '') + '」…首次需要下载解密');
    window.mine.amPlay({ adamId: String(adamId) }).then(function (r) {
      if (r && r.ok && r.path) {
        window.mine.engine('play', { path: r.path }).then(function () {
          // ⚠️ 2026-10-23 修复「AM 播放后顶栏信息错误、没封面」：
          //   之前只调 engine('play')，没有设置 state.currentPath / currentStream，
          //   顶栏（refreshNowPlaying）不知道在播什么 → 显示旧信息或文件路径、无封面。
          //   这里把 AM 歌曲元数据包装成 currentStream（和在线播放链路一致），再刷新。
          try {
            var st = window.state;
            if (st) {
              // ⚠️ 关键：currentPath 必须是**播放路径**（缓存 mp4），
              //    歌词面板 loadLyrics(state.currentStream ? state.currentPath : ...) 用它当 key；
              //    之前设成 null → 歌词永远不加载。
              st.currentPath = r.path;
              st.currentStream = {
                url: r.path,
                song: song,
                title: song.name || '',
                artist: song.artist || song.singer || '',
                album: song.album || song.albumName || '',
                cover: song.cover || song.img || song.pic || '',
                provider: 'alac',
              };
              st.playing = true;
            }
            if (window.__annieAMInternal && window.__annieAMInternal.refreshNowPlaying) {
              window.__annieAMInternal.refreshNowPlaying();
            }
          } catch (e0) { }
          // ⚠️ 2026-10-23 新增：AM 歌曲歌词加载（此前完全没有这段逻辑 → 歌词区空白）
          //   走 streamLyric 的 alac 分支（LiteAPI /lyrics → TTML → LRC），
          //   注入 __annieStreamLrcByPath[r.path]，歌词面板通过 annie-stream-lyric 事件刷新。
          if (window.mine.streamLyric) {
            window.mine.streamLyric({ provider: 'alac', song: song }).then(function (ly) {
              if (!ly || !ly.lrc) return;
              window.__annieStreamLrcByPath = window.__annieStreamLrcByPath || {};
              window.__annieStreamLrcByPath[r.path] = ly.lrc;
              window.__annieStreamTlyByPath = window.__annieStreamTlyByPath || {};
              window.__annieStreamTlyByPath[r.path] = ly.tlyric || '';
              try {
                document.dispatchEvent(new CustomEvent('annie-stream-lyric', { detail: { path: r.path } }));
              } catch (e1) { }
            }).catch(function () { });
          }
          if (typeof proToast === 'function') proToast('正在播放：' + (song.name || ''));
        }).catch(function (e) {
          if (typeof proToast === 'function') proToast('播放失败：' + (e.message || e));
        });
      } else {
        if (typeof proToast === 'function') proToast('获取播放地址失败：' + ((r && r.error) || '未知错误'));
      }
    }).catch(function (e) {
      if (typeof proToast === 'function') proToast('播放请求失败：' + (e.message || e));
    });
  }

  /* ---------------- 入口 ---------------- */
  window.annieAMApple = {
    render: function (c) {
      // ⚠️ 2026-10-22：forceLogin 让「重新登录」按钮能强制打开登录页
      if (ST.forceLogin) { renderLogin(c); return; }
      // ⚠️ 2026-10-22 修复「点 AM 会闪一下登录页」：
      //    原来 ST.st 为 null（异步状态还没回来）时直接 renderLogin，
      //    等 loadStatus() 返回后再切到主界面 → 用户看到登录页闪一下。
      //    现在状态未知时先显示「加载中」占位，不渲染登录页。
      if (!ST.st) {
        if (!ST.checking) loadStatus();
        c.innerHTML = '';
        var loading = el('div', 'am-empty', '正在读取 Apple Music 登录状态…');
        c.appendChild(loading);
        return;
      }
      if (ST.st.loggedIn) renderMain(c);
      else renderLogin(c);
    },
    reload: loadStatus,
  };

  console.log('[apple] Apple Music 板块已加载');
})();
