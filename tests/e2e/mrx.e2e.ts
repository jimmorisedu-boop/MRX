import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { SIGN_IN_PATH } from './session.ts'

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(E2E_DIR, 'fixtures', name)

type JobState = {
  name: string
  status: string
  text: string
  outputCount: number
  downloadCount: number
  zipCount: number
} | null

async function readJob(browser: any, name: string): Promise<JobState> {
  return browser.evaluate((target: string) => {
    const node = [...document.querySelectorAll<HTMLElement>('li.job-card')]
      .find((item) => item.querySelector('.job-name')?.textContent === target)
    if (!node) return null
    return {
      name: target,
      status: node.dataset.status || '',
      text: node.textContent || '',
      outputCount: node.querySelectorAll('.output-row').length,
      downloadCount: node.querySelectorAll('.output-row a[download]').length,
      zipCount: node.querySelectorAll('.zip-row a[download]').length,
    }
  }, name)
}

async function waitForJob(browser: any, name: string, status: string, timeout = 300_000) {
  await expect
    .poll(() => readJob(browser, name), { timeout, interval: 500, message: `${name} did not reach ${status}` })
    .toMatchObject({ status })
}

async function jobCard(browser: any, name: string) {
  const card = browser.locator('li.job-card').filter({ hasText: name })
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  if (await browser.locator('#file-switcher').isVisible()) return selectJob(browser, name)
  await expect(card).toBeVisible({ timeout: 30_000 })
  return card
}

async function selectJob(browser: any, name: string) {
  let value = ''
  await expect.poll(async () => {
    value = await browser.evaluate((target: string) => {
      const option = [...document.querySelectorAll<HTMLOptionElement>('#file-select option')]
        .find((item) => item.textContent?.startsWith(target))
      return option?.value || ''
    }, name)
    return value
  }, { timeout: 30_000, interval: 200, message: `No file-switcher option found for ${name}` }).not.toBe('')
  await browser.locator('#file-select').selectOption({ value })
  await expect(browser.locator('li.job-card:not([hidden])').filter({ hasText: name })).toBeVisible({ timeout: 30_000 })
  return browser.locator('li.job-card').filter({ hasText: name })
}

async function previewToggle(browser: any, name: string) {
  const jobId = await browser.evaluate((target: string) => {
    const card = [...document.querySelectorAll<HTMLElement>('li.job-card')]
      .find((item) => item.querySelector('.job-name')?.textContent === target)
    return card?.dataset.jobId || ''
  }, name)
  if (!jobId) throw new Error(`No job card id found for ${name}`)
  return browser.locator(`li.job-card[data-job-id="${jobId}"] button.preview-toggle`).first()
}

async function upload(browser: any, names: string | string[]) {
  const files = (Array.isArray(names) ? names : [names]).map(fixture)
  await browser.locator('#file-input').setInputFiles(files)
}

test('an audio error does not block a later valid file', async ({ app, browser, screen }) => {
  await app.open(SIGN_IN_PATH)
  await expect(screen.getByRole('heading', { name: 'Разделить звук' })).toBeVisible()

  await upload(browser, 'no-audio.mp4')
  await waitForJob(browser, 'no-audio.mp4', 'error', 120_000)
  const failed = await readJob(browser, 'no-audio.mp4')
  expect(failed?.text).toMatch(/аудиодорожка|аудио/i)

  await upload(browser, 'recovery.wav')
  await waitForJob(browser, 'recovery.wav', 'done')
  const recovered = await readJob(browser, 'recovery.wav')
  expect(recovered).toMatchObject({ outputCount: 3, downloadCount: 3, zipCount: 1 })
})

test('three WAV files produce three stems, ZIP, and stable previews', async ({ app, browser, screen }) => {
  await app.open(SIGN_IN_PATH)
  await expect(screen.getByRole('heading', { name: 'Разделить звук' })).toBeVisible()

  const names = ['batch-a.wav', 'batch-b.wav', 'batch-c.wav']
  await upload(browser, names)
  for (const name of names) await waitForJob(browser, name, 'done')

  for (const name of names) {
    const state = await readJob(browser, name)
    expect(state).toMatchObject({ outputCount: 3, downloadCount: 3, zipCount: 1 })
  }

  const cardA = await selectJob(browser, 'batch-a.wav')
  const stemDownload = await browser.waitForDownload(() => cardA.getByRole('link').first().tap())
  const stemBytes = await readFile(stemDownload.absolutePath)
  expect(stemBytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(stemBytes.length).toBeGreaterThan(44)

  const zipDownload = await browser.waitForDownload(() => cardA.getByRole('link').last().tap())
  const zipBytes = await readFile(zipDownload.absolutePath)
  expect(zipBytes.subarray(0, 2).toString('ascii')).toBe('PK')
  expect(zipBytes.length).toBeGreaterThan(100)

  const toggleA = await previewToggle(browser, 'batch-a.wav')
  await expect.poll(() => browser.evaluate((name: string) => {
    const card = [...document.querySelectorAll<HTMLElement>('li.job-card')]
      .find((item) => item.querySelector('.job-name')?.textContent === name)
    return Number((card?.querySelector('audio') as HTMLAudioElement | null)?.duration || 0)
  }, 'batch-a.wav'), { timeout: 30_000, interval: 200 }).toBeGreaterThan(0.5)

  await toggleA.tap()
  await expect(toggleA).toHaveAttribute('data-playing', 'true', { timeout: 10_000 })
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  await expect(toggleA).toHaveAttribute('data-playing', 'true', { timeout: 10_000 })

  const cardB = await selectJob(browser, 'batch-b.wav')
  const toggleB = await previewToggle(browser, 'batch-b.wav')
  await toggleB.tap()
  await expect(toggleB).toHaveAttribute('data-playing', 'true', { timeout: 10_000 })
  await expect(toggleA).toHaveAttribute('data-playing', 'false', { timeout: 10_000 })

  const seekResult = await browser.evaluate((name: string) => {
    const card = [...document.querySelectorAll<HTMLElement>('li.job-card')]
      .find((item) => item.querySelector('.job-name')?.textContent === name)
    const audio = card?.querySelector('audio') as HTMLAudioElement | null
    const seek = card?.querySelector('.preview-seek') as HTMLInputElement | null
    if (!audio || !seek || !Number.isFinite(audio.duration) || audio.duration <= 0) return 0
    const target = Math.min(audio.duration * 0.5, Math.max(1, audio.duration - 0.25))
    seek.value = String(target)
    seek.dispatchEvent(new Event('input', { bubbles: true }))
    return audio.currentTime
  }, 'batch-b.wav')
  expect(seekResult).toBeGreaterThan(0.5)
  await toggleB.tap()
  await expect(toggleB).toHaveAttribute('data-playing', 'false', { timeout: 10_000 })
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  await expect.poll(() => browser.evaluate((name: string) => {
    const card = [...document.querySelectorAll<HTMLElement>('li.job-card')]
      .find((item) => item.querySelector('.job-name')?.textContent === name)
    return Number((card?.querySelector('audio') as HTMLAudioElement | null)?.currentTime || 0)
  }, 'batch-b.wav'), { timeout: 10_000, interval: 200 }).toBeGreaterThan(0.5)
})

test('cancelling a job allows a later job to recover', async ({ app, browser, screen }) => {
  await app.open(SIGN_IN_PATH)
  await expect(screen.getByRole('heading', { name: 'Разделить звук' })).toBeVisible()

  await upload(browser, 'cancel.wav')
  const card = await jobCard(browser, 'cancel.wav')
  await card.getByRole('button', /Отменить/).tap({ timeout: 10_000 })
  await waitForJob(browser, 'cancel.wav', 'cancelled', 60_000)

  await upload(browser, 'post-cancel.wav')
  await waitForJob(browser, 'post-cancel.wav', 'done')
  const recovered = await readJob(browser, 'post-cancel.wav')
  expect(recovered).toMatchObject({ outputCount: 3, downloadCount: 3, zipCount: 1 })

  // Removal needs a second tap on the same button; the first one only arms it.
  const cancelledCard = await selectJob(browser, 'cancel.wav')
  await cancelledCard.getByRole('button', /Убрать файл cancel\.wav/).tap()
  await expect(cancelledCard.getByRole('button', /Убрать файл cancel\.wav/)).toHaveText('Убрать из списка?')
  await cancelledCard.getByRole('button', /Убрать файл cancel\.wav/).tap()
  await expect.poll(() => readJob(browser, 'cancel.wav'), { timeout: 10_000, interval: 200 }).toBeNull()

  const doneCard = await jobCard(browser, 'post-cancel.wav')
  await doneCard.getByRole('button', /Удалить результаты файла post-cancel\.wav/).tap()
  await doneCard.getByRole('button', /Удалить результаты файла post-cancel\.wav/).tap()
  await expect.poll(() => readJob(browser, 'post-cancel.wav'), { timeout: 10_000, interval: 200 }).toBeNull()
})
