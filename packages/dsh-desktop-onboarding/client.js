window.__ModuleLoader__.load({
  id: 'dsh-desktop-onboarding',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'desktop-onboarding'
    // Settings section the "configure a model" action opens.
    const MODELS_SECTION_ID = 'models'

    const STYLE_ID = 'dsh-desktop-onboarding-style'
    // Same dialog chrome as the stock welcome notice it replaces: a bounded
    // card whose body scrolls while the brand row and actions stay put.
    const STYLE = `
      .dshDeskOnbDialog{width:min(600px,100%);padding:0}
      .dshDeskOnbContent{box-sizing:border-box;display:flex;flex-direction:column;max-height:calc(100vh - 48px);padding:24px 28px}
      .dshDeskOnbHeader{flex:none;display:flex;align-items:center;gap:10px}
      .dshDeskOnbBrandMark{display:inline-flex;align-items:center;color:var(--dsw-alias-label-primary);font-size:18px;font-weight:700}
      .dshDeskOnbBrandName{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:22px}
      .dshDeskOnbBrandBy{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px}
      .dshDeskOnbHeading{flex:none;color:var(--dsw-alias-label-primary);outline:none;margin:16px 0 0;font-size:20px;font-weight:500;line-height:28px}
      .dshDeskOnbBody{flex:1;min-height:0;margin-top:12px;overflow-y:auto}
      .dshDeskOnbParagraph{margin:0 0 10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dshDeskOnbSubheading{margin:14px 0 6px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:20px}
      .dshDeskOnbHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
      .dshDeskOnbActions{flex:none;display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
      @media (width<=560px){.dshDeskOnbContent{padding:20px}}
    `

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-desktop-onboarding'
      style.textContent = STYLE
      document.head.appendChild(style)
    }

    // ---------- locale dictionaries ----------

    const en = {
      brandName: 'Pengbao AI',
      brandBy: '',
      step0Title: 'Before you begin',
      declarationBody: 'Pengbao AI runs local tools on your computer. When you use an AI model, your messages, relevant file contents and tool results may be sent to Pengbao for processing. Local execution does not mean your content stays on this device.',
      desktopIntroTitle: 'Your workspace',
      desktopIntroBody: 'Your local sessions are kept separately for each signed-in account. Signing out does not delete your local work.',
      desktopIntroFeedback: 'Model access is determined by your Pengbao account.',
      configureModel: 'View models',
      later: 'Maybe later',
      saveFailed: 'Could not save your acknowledgment. Please try again.'
    }

    const zh = {
      brandName: '鹏宝 AI',
      brandBy: '',
      step0Title: '使用前须知',
      declarationBody: '鹏宝 AI 会在本机执行工具。使用 AI 模型时，你的消息、相关文件内容和工具结果可能发送至鹏宝进行处理。本地执行不代表内容始终留在本机。',
      desktopIntroTitle: '你的工作区',
      desktopIntroBody: '本地会话按登录账号分别保存。退出登录不会删除本地工作内容。',
      desktopIntroFeedback: '可用模型以鹏宝账号的权限为准。',
      configureModel: '查看模型',
      later: '稍后再说',
      saveFailed: '未能保存确认，请重试。'
    }

    // ---------- components ----------

    function BrandHeader({ t }) {
      return React.createElement(
        'div',
        { className: 'dshDeskOnbHeader' },
        React.createElement('span', { className: 'dshDeskOnbBrandMark', 'aria-hidden': 'true' }, '鹏'),
        React.createElement('span', { className: 'dshDeskOnbBrandName' }, t('brandName'))
      )
    }

    // Explain which work stays local and what can be sent to the model service.
    function NoticeBody({ t }) {
      const paragraphs = t('declarationBody').split('\n\n')
      return React.createElement(
        'div',
        { className: 'dshDeskOnbBody' },
        paragraphs.map((paragraph, idx) =>
          React.createElement('p', { key: idx, className: 'dshDeskOnbParagraph' }, paragraph)
        ),
        React.createElement('h3', { className: 'dshDeskOnbSubheading' }, t('desktopIntroTitle')),
        React.createElement('p', { className: 'dshDeskOnbParagraph' }, t('desktopIntroBody')),
        React.createElement('p', { className: 'dshDeskOnbHint' }, t('desktopIntroFeedback'))
      )
    }

    // The notice is blocking: implicit dismissal (Escape, backdrop) is ignored
    // so the user leaves through one of the two explicit actions.
    const ignoreImplicitDismiss = () => {}

    function onboardingDecision(value) {
      const acknowledged = typeof value?.wizardVersion === 'string' && value.wizardVersion.length > 0
      return value?.eligible === true && !acknowledged ? 'show' : 'complete'
    }

    // ---------- the first-run notice ----------

    function DesktopOnboardingNotice(props) {
      const { complete, openSection, t } = props
      const wizardScope = props.controller.scope
      const [decision, setDecision] = useState('loading')
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(false)
      const titleRef = useRef(null)
      const finishedRef = useRef(false)

      // Persist the acknowledgement, then hand the onboarding slot back. The
      // optional follow-up runs after the slot is released (e.g. opening the
      // models settings section).
      const finish = useCallback(async (followUp) => {
        if (finishedRef.current) return
        finishedRef.current = true
        setSaving(true)
        setSaveError(false)
        try {
          const response = await fetch('/api/desktop-onboarding/acknowledge', { method: 'POST', credentials: 'same-origin', cache: 'no-store' })
          if (!response.ok || (await response.json()).acknowledged !== true) throw new Error('Acknowledgment was not saved')
          complete()
          if (followUp) followUp()
        } catch {
          finishedRef.current = false
          setSaving(false)
          setSaveError(true)
        }
      }, [complete])

      useEffect(() => {
        const read = () => {
          const snap = wizardScope.getSnapshot()
          // Wait for the Host section so returning users never see a flash.
          if (snap.mode !== 'memory' && snap.status === 'loading') return
          const value = snap.value ?? {}
          setDecision(onboardingDecision(value))
        }
        let unsubscribe
        try {
          unsubscribe = wizardScope.subscribe(read)
          read()
        } catch {
          // Scope errors are non-fatal: a failing scope must not block boot.
        }
        return () => { if (unsubscribe) unsubscribe() }
      }, [wizardScope])

      // Ineligible installs and every prior acknowledgement skip straight on.
      useEffect(() => {
        if (decision === 'complete' && !finishedRef.current) {
          finishedRef.current = true
          complete()
        }
      }, [decision, complete])

      const visible = decision === 'show'

      // Keep the application behind the dialog inert, like the stock notice.
      useEffect(() => {
        if (!visible) return
        const appRoot = document.getElementById('root')
        if (appRoot === null) return
        const previous = appRoot.inert
        appRoot.inert = true
        return () => { appRoot.inert = previous }
      }, [visible])

      useEffect(() => {
        if (visible) titleRef.current?.focus()
      }, [visible])

      if (!visible) return null

      return React.createElement(
        Modal,
        {
          open: true,
          title: t('step0Title'),
          onClose: ignoreImplicitDismiss,
          headless: true,
          className: 'dshDeskOnbDialog'
        },
        React.createElement(
          'div',
          { className: 'dshDeskOnbContent' },
          React.createElement(BrandHeader, { t }),
          React.createElement(
            'h2',
            { ref: titleRef, className: 'dshDeskOnbHeading', tabIndex: -1 },
            t('step0Title')
          ),
          React.createElement(NoticeBody, { t }),
          saveError ? React.createElement('p', { role: 'alert', className: 'dshDeskOnbHint' }, t('saveFailed')) : null,
          React.createElement(
            'div',
            { className: 'dshDeskOnbActions' },
            React.createElement(
              Button,
              { variant: 'outline', disabled: saving, onClick: () => finish() },
              t('later')
            ),
            React.createElement(
              Button,
              {
                variant: 'primary',
                disabled: saving,
                onClick: () => finish(() => {
                  if (typeof openSection === 'function') openSection(MODELS_SECTION_ID)
                })
              },
              t('configureModel')
            )
          )
        )
      )
    }

    // ---------- composition ----------

    function apply(ctx) {
      ctx.inject(['slots', 'locale', 'configForms'], (scope) => {
        installStyles()
        const t = scope.locale.bind(NS)

        const wizardScope = scope.configForms.get('dsh-desktop-onboarding')

        scope.locale.register(NS, { zh, en })

        const controller = { scope: wizardScope }

        // The stock welcome-notice / official-DeepSeek onboarding entries are
        // removed upstream by the settings-models patch (the desktop notice owns
        // first-run), so this notice registers under its own id — no shadowing.
        scope.slots.inject('settings.onboarding', () => scope.slots.register({
          name: 'settings.onboarding',
          id: 'dsh-desktop-onboarding',
          order: 0,
          inject: () => ({ controller, t })
        }, DesktopOnboardingNotice))
      })
    }

    const inject = []

    exports.apply = apply
    exports.inject = inject
    exports.onboardingDecision = onboardingDecision
    return module.exports
  }
})
