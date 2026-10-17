import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Banner } from './components'
import { Modal } from './common'

/**
 * Camera barcode scanning. The scanner (BarcodeDetector, or zxing-wasm as fallback) is imported only when this opens,
 * so it never touches first-load JS or the offline billing path.
 */
export function CameraScanModal({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const video = useRef<HTMLVideoElement>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const onCodeRef = useRef(onCode)
  useEffect(() => {
    onCodeRef.current = onCode
  })

  useEffect(() => {
    let stopFn: (() => void) | null = null
    let live = true
    import('../catalogue/cameraScanner')
      .then(async (m) => {
        if (!live || !video.current) return
        stopFn = m.stop
        await m.start(video.current, (code) => {
          m.stop()
          onCodeRef.current(code)
        })
      })
      .catch((e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
      stopFn?.()
    }
  }, [])

  return (
    <Modal title={t('scan.title')} onClose={onClose} testId="camera-modal">
      <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12, background: '#000', minHeight: 200 }} />
      <p className="muted">{t('scan.hint')}</p>
      {problem && <Banner kind="error">{t('scan.cameraProblem')}</Banner>}
    </Modal>
  )
}
