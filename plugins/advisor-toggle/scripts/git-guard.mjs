// R2：提交期间的 HEAD/父子关系守卫。纯函数，只做判定，不做任何 git 变更。
// 顾问要求：发现异常时**立即停止**，不自动 reset、不 checkout、不 branch -f、不强推，
// 只报告并标记需要人工恢复。因此这个模块只返回结论，绝不包含会改动引用的动作。
export const STOP = 'stop'
export const PASS = 'pass'

/**
 * @param {{headBefore?:string, headNow?:string, expectedParent?:string, actualParent?:string}} input
 */
export function evaluate(input = {}) {
  const headBefore = String(input.headBefore || '')
  const headNow = String(input.headNow || '')
  const expectedParent = String(input.expectedParent ?? headBefore)
  const actualParent = String(input.actualParent || '')

  if (!headBefore || !headNow) {
    return {
      action: STOP,
      reason: 'missing-head',
      needsHuman: true,
      detail: '提交前/后没取到 HEAD，无法证明这次提交落在预期位置。',
      headBefore,
      headNow,
      expectedParent,
      actualParent,
    }
  }
  if (headNow === headBefore) {
    return {
      action: STOP,
      reason: 'no-new-commit',
      needsHuman: true,
      detail: 'HEAD 没变：提交没成功，或提交期间被别的进程回退。',
      headBefore,
      headNow,
      expectedParent,
      actualParent,
    }
  }
  if (actualParent !== expectedParent) {
    return {
      action: STOP,
      reason: 'parent-mismatch',
      needsHuman: true,
      detail: '新提交的父提交不是提交前的 HEAD：期间有别的进程动过引用。停止并保留现状。',
      headBefore,
      headNow,
      expectedParent,
      actualParent,
    }
  }
  return {
    action: PASS,
    reason: '',
    needsHuman: false,
    detail: '提交落点与预期一致。',
    headBefore,
    headNow,
    expectedParent,
    actualParent,
  }
}

// 供 runbook/测试断言：这个模块只做判定，不允许出现改动引用的动作。
export const FORBIDDEN_ACTIONS = ['reset', 'checkout', 'branch -f', 'push --force', 'push -f']
