/**
 * `medharness` namespace dictionaries, and the namespace's declaration.
 *
 * The copy is written for the person filling in their own intake, not for a
 * maintainer: no internal term appears here. The two evidence headings are the
 * load-bearing strings — PATIENT REPORTED and MODEL OBSERVED must never be
 * confusable, because the whole point of showing them side by side is that a
 * reader can tell who said what.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'medharness'>` or `PropsLocale<'medharness'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Intake surface headings, field labels, and progress copy. */
    medharness: MedharnessKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'brand.name': 'MedHarness',
  'brand.tagline': 'AI 就诊前信息采集',
  'action.newIntake': '+ 新建接诊',
  'action.creating': '正在创建接诊…',
  'recent.title': '最近接诊',
  'recent.loading': '正在加载接诊…',
  'recent.empty': '还没有历史接诊。',
  'recent.emptyAction': '开始第一次接诊',
  'error.create': '无法创建新的接诊。',
  'error.list': '无法加载最近的接诊。',
  'time.today': '今天',
  'time.yesterday': '昨天',
  'type.label': '接诊记录',
  'guide.title': '接诊记录',
  'guide.description': '查看本次问诊已记录的信息与图像观察',
  'panel.reported.title': '您提供的信息',
  'panel.reported.caption': '由您陈述，系统据此记录',
  'panel.observed.title': '图像观察结果',
  'panel.observed.caption': '模型在您上传的图片中直接看到的内容',
  'progress.title': '信息完整度',
  'progress.complete': '必填信息已齐备',
  'field.symptoms': '症状',
  'field.duration': '持续时间',
  'field.age': '年龄',
  'field.notes': '补充说明',
  'field.revision': '记录版本',
  'field.updatedAt': '最近更新',
  'state.missing': '待补充',
  'state.notProvided': '未提供',
  'state.empty': '还没有记录。开始对话后，这里会显示您提供的信息。',
  'state.loading': '正在读取…',
  'image.empty': '还没有图像观察。上传图片后，这里会显示模型在图中看到的内容。',
  'image.label': '图片 {index}',
  'image.revision': '版本 {revision}',
  'image.region': '部位',
  'image.findings': '可见发现',
  'image.quality': '图像质量',
  'image.uncertainty': '无法判定',
  'image.usable': '可评估',
  'image.unusable': '无法可靠评估',
  'image.none': '无',
} satisfies Record<string, string>

/** MedHarness intake dictionary key union. */
export type MedharnessKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'brand.name': 'MedHarness',
  'brand.tagline': 'AI-assisted pre-consultation intake',
  'action.newIntake': '+ New Intake',
  'action.creating': 'Creating intake…',
  'recent.title': 'Recent Intakes',
  'recent.loading': 'Loading intakes…',
  'recent.empty': 'No previous intakes yet.',
  'recent.emptyAction': 'Start your first intake',
  'error.create': 'Unable to create a new intake.',
  'error.list': 'Unable to load recent intakes.',
  'time.today': 'Today',
  'time.yesterday': 'Yesterday',
  'type.label': 'Intake',
  'guide.title': 'Intake record',
  'guide.description': 'See what this consultation has recorded so far, and what the images showed',
  'panel.reported.title': 'What you told us',
  'panel.reported.caption': 'Stated by you, recorded as you said it',
  'panel.observed.title': 'What the images showed',
  'panel.observed.caption': 'What the model could see directly in the images you attached',
  'progress.title': 'Information completeness',
  'progress.complete': 'All required information is recorded',
  'field.symptoms': 'Symptoms',
  'field.duration': 'Duration',
  'field.age': 'Age',
  'field.notes': 'Notes',
  'field.revision': 'Revision',
  'field.updatedAt': 'Last updated',
  'state.missing': 'Still needed',
  'state.notProvided': 'Not provided',
  'state.empty': 'Nothing recorded yet. Once the conversation starts, what you tell us appears here.',
  'state.loading': 'Reading…',
  'image.empty': 'No image observations yet. Once you attach a photo, what the model could see in it appears here.',
  'image.label': 'Image {index}',
  'image.revision': 'Revision {revision}',
  'image.region': 'Body region',
  'image.findings': 'Visible findings',
  'image.quality': 'Image quality',
  'image.uncertainty': 'Could not determine',
  'image.usable': 'Assessable',
  'image.unusable': 'Cannot be assessed reliably',
  'image.none': 'None',
} satisfies Record<MedharnessKey, string>
