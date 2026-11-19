window.__ModuleLoader__.load({
  id: 'advisor-toggle',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const PLUGIN = 'advisor-toggle'
    const SLOT = 'conversation.input.left'
    const API = '/api/advisor-toggle'
    const STYLE_ID = 'advisor-toggle-styles'

    const C = {
      idle: 'rgba(255,255,255,0.06)',
      idleBorder: 'rgba(255,255,255,0.14)',
      idleText: 'rgba(235,238,245,0.72)',
      on: 'rgba(245,196,81,0.16)',
      onBorder: 'rgba(245,196,81,0.62)',
      onText: '#F5C66B',
      alert: '#FF6B6B',
      warn: 'rgba(255,160,120,0.85)',
    }

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.advisor-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:999px;
  border:1px solid ${C.idleBorder};background:${C.idle};color:${C.idleText};font-size:12px;line-height:1;
  cursor:pointer;user-select:none;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .12s ease}
.advisor-chip:hover{transform:translateY(-1px)}
.advisor-chip:disabled{cursor:progress;opacity:.7}
.advisor-chip[data-on="1"]{background:${C.on};border-color:${C.onBorder};color:${C.onText}}
.advisor-chip[data-stale="1"]{border-color:${C.warn};color:${C.warn}}
.advisor-chip .advisor-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55}
.advisor-chip[data-on="1"] .advisor-dot{opacity:1;box-shadow:0 0 8px currentColor}
.advisor-chip[data-alert="1"] .advisor-dot{background:${C.alert};box-shadow:0 0 8px ${C.alert}}
.advisor-chip[data-config="1"]{border-color:${C.alert};color:${C.alert};cursor:not-allowed}
.advisor-chip[data-config="1"] .advisor-dot{background:${C.alert};opacity:1}
.advisor-chip .advisor-label{font-variant-numeric:tabular-nums}
`
      document.head.appendChild(style)
    }

    // 这个槽的 standardProps 里带 sessionId，直接用它；
    // 不再退回 useSessions 扫描 byId（多会话同时 mainView>0 时会绑错会话，且是条件调用 Hook）。
    function sessionOf(props) {
      const id = props && props.sessionId
      return id ? String(id) : ''
    }

    function AdvisorChip(props) {
      ensureStyles()
      const sessionId = sessionOf(props)
      const [state, setState] = useState({ enabled: false, noGoStreak: 0 })
      const [busy, setBusy] = useState(false)
      const [stale, setStale] = useState(false)
      const inflight = useRef(false)
      const seq = useRef(0)
      const abort = useRef(null)
      const pressTimer = useRef(null)
      // 乐观并发：把服务端返回的 stateVersion 带给 /toggle，过期就 409。
      const stateVersion = useRef(0)
      // 长按结束后浏览器可能还会补一个 click：吃掉它，别让 override 又触发 toggle。
      const suppressClick = useRef(false)
      // 这一次按住到底算不算「长按已触发」。短按要放行 click（正常开关），
      // 长按必须吃掉 click——否则 override 关掉后立刻被这个 click 重新打开。
      const longPressFired = useRef(false)
      // 只认真实按住的那根手指/鼠标，多指或换指不触发应急解除。
      const pressPointerId = useRef(null)

      const refresh = useCallback(async () => {
        if (!sessionId) return
        const mySeq = ++seq.current
        if (abort.current) abort.current.abort()
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        abort.current = controller
        try {
          const response = await fetch(`${API}/state?session=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          if (mySeq !== seq.current) return // 迟到的旧响应不再覆盖新状态
          stateVersion.current = Number(next.stateVersion || 0)
          setState({
            enabled: Boolean(next.enabled),
            noGoStreak: Number(next.noGoStreak || 0),
            alert: Boolean(next.alert),
          })
          setStale(false)
        } catch (error) {
          if (error && error.name === 'AbortError') return
          if (mySeq === seq.current) setStale(true) // 拿不准就不假装一切正常
        }
      }, [sessionId])

      useEffect(() => {
        let cancelled = false
        let timer = null
        const tick = async () => {
          if (cancelled) return
          if (document.visibilityState !== 'hidden') await refresh()
          if (!cancelled) timer = setTimeout(tick, 5000)
        }
        tick()
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
          if (abort.current) abort.current.abort()
        }
      }, [refresh])

      const toggle = useCallback(async () => {
        if (!sessionId || inflight.current) return // 同步锁，防双击连发
        inflight.current = true
        setBusy(true)
        // 先作废所有在途的 GET：它们带的是点击之前的状态，不能回写覆盖这次操作。
        seq.current += 1
        if (abort.current) abort.current.abort()
        const target = !state.enabled
        try {
          const response = await fetch(`${API}/toggle`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              session: sessionId,
              enabled: target,
              expectedVersion: stateVersion.current,
            }),
          })
          if (response.status === 409) {
            // 服务端状态已经变了（别处点了开关）：不硬写，拉回来重画。
            await refresh()
            return
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          stateVersion.current = Number(next.stateVersion || stateVersion.current)
          setState({ enabled: Boolean(next.enabled), noGoStreak: 0, alert: false })
          setStale(false)
          await refresh() // 打开时服务端会重算版本，顺手同步一次
        } catch {
          await refresh() // 失败就拉回服务端真实状态，而不是自己猜
        } finally {
          inflight.current = false
          setBusy(false)
        }
      }, [refresh, sessionId, state.enabled])

      // 应急出口：只在界面上长按 3 秒才会走到 /override。
      // Agent 没有任何工具能触发它；而且服务端要求先领一张 30 秒一次性挑战票，
      // 所以盲调 curl 只会拿到 403（挡的是低成本伪造，不是"有人在现场"的证明）。
      const challengeRef = useRef(null)

      const fetchChallenge = useCallback(async () => {
        if (!sessionId) return null
        try {
          const response = await fetch(`${API}/override/challenge`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId }),
          })
          if (!response.ok) return null
          const ticket = await response.json()
          challengeRef.current = ticket
          return ticket
        } catch {
          return null
        }
      }, [sessionId])

      const clearPress = useCallback((event) => {
        // 只清理发起本次长按的那根手指；别的手指松开不应打断本次长按。
        if (event && pressPointerId.current !== null && event.pointerId !== pressPointerId.current) return
        pressPointerId.current = null
        if (pressTimer.current) {
          clearTimeout(pressTimer.current)
          pressTimer.current = null
        }
      }, [])

      const startOverridePress = useCallback(
        (event) => {
          if (!sessionId || !state.enabled) return
          clearPress()
          pressPointerId.current = event ? event.pointerId : null
          // 无论长按成功与否，随后的 click 都不该再触发普通 toggle。
          suppressClick.current = true
          longPressFired.current = false
          // 按下就去领票：等 3 秒结束再领，票的有效期会被长按吃掉。
          void fetchChallenge()
          pressTimer.current = setTimeout(async () => {
            pressTimer.current = null
            pressPointerId.current = null
            longPressFired.current = true
            seq.current += 1 // 使在途 GET 作废
            try {
              let ticket = challengeRef.current
              if (!ticket || (ticket.expiresAt && ticket.expiresAt < Date.now())) ticket = await fetchChallenge()
              const response = await fetch(`${API}/override`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  session: sessionId,
                  confirm: 'user',
                  challengeId: ticket ? ticket.challengeId : '',
                  nonce: ticket ? ticket.nonce : '',
                }),
              })
              challengeRef.current = null
              if (response.ok) {
                setState({ enabled: false, noGoStreak: 0, alert: false })
                setStale(false)
                await refresh()
              } else {
                await refresh()
              }
            } catch {
              await refresh()
            }
          }, 3000)
        },
        [clearPress, fetchChallenge, refresh, sessionId, state.enabled],
      )

      // 短按（没到 3 秒就抬手）要放行随后的 click，否则正常点开关会被吃掉一次；
      // 长按已经触发 override 时绝不放行——那一次 click 必须由 onClick 吃掉，
      // 这就是 2026-11-18 现场「override 后 0.5 秒被 toggle 重新打开」的根因。
      useEffect(() => {
        const release = () => {
          if (!longPressFired.current) suppressClick.current = false
        }
        window.addEventListener('pointerup', release)
        window.addEventListener('pointercancel', release)
        return () => {
          window.removeEventListener('pointerup', release)
          window.removeEventListener('pointercancel', release)
        }
      }, [])

      useEffect(
        () => () => {
          if (pressTimer.current) clearTimeout(pressTimer.current)
        },
        [],
      )

      if (!sessionId) return null

      // 未配置 workspace 时开关没有意义：必须把"配置缺失"直接摆在按钮上，
      // 而不是让用户点了一下才发现没反应（顾问验收要求：不许静默失效）。
      const misconfigured = Boolean(state.workspaceState && state.workspaceState !== 'ready')
      const configHint = state.configError ? `（${state.configError}）` : ''

      const label = state.enabled ? '顾问已开启' : '顾问开关'
      return h(
        'button',
        {
          type: 'button',
          className: 'advisor-chip',
          'data-on': state.enabled ? '1' : '0',
          'data-alert': misconfigured ? 'config' : state.alert || state.noGoStreak >= 3 ? '1' : '0',
          'data-config': misconfigured ? '1' : '0',
          'data-stale': stale ? '1' : '0',
          title: stale
            ? '顾问开关：状态同步失败，显示可能不是最新的'
            : misconfigured
              ? `顾问开关不可用：未配置 workspace${configHint}。请在 profile 的 cordis.patch.yml 里给 advisor-toggle 设置 workspace，或设置环境变量 DSH_WORKSPACE。`
              : state.enabled
                ? '顾问已开启：方案与交付都会先交给 ChatGPT 评审，拿到 GO 才继续。长按 3 秒可应急解除（写审计日志）。'
                : '顾问开关：打开后，方案与交付先交给 ChatGPT 评审',
          onClick: () => {
            // 长按刚结束时浏览器会补一个 click，这一次不当作开关切换。
            if (suppressClick.current) {
              suppressClick.current = false
              longPressFired.current = false
              return
            }
            // 配置不可用时点了也不会生效，直接不切（按钮上已标出原因）。
            if (misconfigured) return
            toggle()
          },
          onPointerDown: startOverridePress,
          onPointerUp: clearPress,
          onPointerLeave: clearPress,
          onPointerCancel: clearPress,
          disabled: busy,
        },
        h('span', { className: 'advisor-dot' }),
        h('span', { className: 'advisor-label' }, label),
      )
    }

    return {
      name: PLUGIN,
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: PLUGIN, order: 30, label: '顾问' }, AdvisorChip),
        )
      },
    }
  },
})
