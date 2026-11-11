import * as koffi from 'koffi'

/**
 * The few Win32 and COM calls the app makes directly: finding another app's
 * window, bringing it to the front, typing into it, and reading its text
 * through UI Automation.
 *
 * Loaded on first use, so nothing native is touched unless one of those is.
 */

const GW_OWNER = 4
const SW_RESTORE = 9
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
export const VK = { RETURN: 0x0d, CONTROL: 0x11, V: 0x56 } as const

const COINIT_APARTMENTTHREADED = 0x2
const CLSCTX_INPROC_SERVER = 0x1
const TreeScope_Descendants = 0x4
const CLSID_CUIAutomation = 'ff48dba4-60ef-4201-aa87-54103eef594e'
const IID_IUIAutomation = '30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'

/**
 * Vtable slots, read from the type library in UIAutomationCore.dll rather
 * than counted by hand. Slots 0–2 are IUnknown on every interface.
 */
const SLOT = {
  Release: 2,
  IUIAutomation_ElementFromHandle: 6,
  IUIAutomation_CreateTrueCondition: 21,
  Element_FindAll: 6,
  Element_CurrentName: 23,
  Element_CurrentAutomationId: 29,
  ElementArray_Length: 3,
  ElementArray_GetElement: 4,
} as const

type Win32 = ReturnType<typeof load>
let cached: Win32 | null = null

export function win32(): Win32 {
  cached ??= load()
  return cached
}

function load() {
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const ole32 = koffi.load('ole32.dll')
  const oleaut32 = koffi.load('oleaut32.dll')

  /* ---------------------------- windows ---------------------------- */

  koffi.proto('bool __stdcall TB_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
  const EnumWindows = user32.func('bool __stdcall EnumWindows(TB_EnumWindowsProc *cb, intptr_t lParam)')
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)')
  const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)')
  const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)')
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)',
  )
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)')
  const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)')
  const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)')
  const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)')
  const AttachThreadInput = user32.func(
    'bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)',
  )
  const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
  const OpenProcess = kernel32.func(
    'intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)',
  )
  const QueryFullProcessImageNameW = kernel32.func(
    'bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)',
  )
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t handle)')

  const processOf = (hwnd: number): number => {
    const pid = [0]
    GetWindowThreadProcessId(hwnd, pid)
    return pid[0] ?? 0
  }

  const imageOf = (pid: number): string | null => {
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) as number
    if (!handle) return null
    try {
      const name = new Uint16Array(1024)
      const size = [name.length]
      if (!QueryFullProcessImageNameW(handle, 0, name, size)) return null
      return String.fromCharCode(...name.subarray(0, size[0] ?? 0))
    } finally {
      CloseHandle(handle)
    }
  }

  /** The first visible, top-level, titled window whose executable path matches. */
  const findAppWindow = (matches: (imagePath: string) => boolean): number | null => {
    let found: number | null = null
    EnumWindows((hwnd: number) => {
      if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) || GetWindowTextLengthW(hwnd) === 0) {
        return true
      }
      const image = imageOf(processOf(hwnd))
      if (!image || !matches(image)) return true
      found = hwnd
      return false
    }, 0)
    return found
  }

  /** By process rather than by window: focus may sit in one of its popups. */
  const isInFront = (hwnd: number): boolean => {
    const front = GetForegroundWindow() as number
    return front !== 0 && processOf(front) === processOf(hwnd)
  }

  /**
   * Raises the window, borrowing the foreground thread's input state for the
   * moment of the switch — without it, Windows refuses SetForegroundWindow
   * once another app has taken the foreground.
   */
  const bringToFront = (hwnd: number): boolean => {
    if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)
    if (isInFront(hwnd)) return true

    const front = GetForegroundWindow() as number
    const frontThread = front ? (GetWindowThreadProcessId(front, [0]) as number) : 0
    const me = GetCurrentThreadId() as number
    const attached = frontThread !== 0 && frontThread !== me && AttachThreadInput(me, frontThread, true)
    try {
      BringWindowToTop(hwnd)
      SetForegroundWindow(hwnd)
    } finally {
      if (attached) AttachThreadInput(me, frontThread, false)
    }
    return isInFront(hwnd)
  }

  /* ------------------------------ keys ----------------------------- */

  const MOUSEINPUT = koffi.struct({
    dx: 'int32_t',
    dy: 'int32_t',
    mouseData: 'uint32_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  })
  const KEYBDINPUT = koffi.struct({
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  })
  const INPUT = koffi.struct('TB_INPUT', {
    type: 'uint32_t',
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT }),
  })
  const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, TB_INPUT *inputs, int size)')

  const key = (vk: number, up: boolean) => ({
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } },
  })

  /** Presses the keys in order, then releases them in reverse: a chord. */
  const pressChord = (...vks: number[]): void => {
    const inputs = [...vks.map((vk) => key(vk, false)), ...[...vks].reverse().map((vk) => key(vk, true))]
    const sent = SendInput(inputs.length, inputs, koffi.sizeof(INPUT)) as number
    if (sent !== inputs.length) throw new Error(`SendInput accepted ${sent} of ${inputs.length} key events`)
  }

  /* --------------------------- UI Automation ----------------------- */

  // Registered by name for the CoCreateInstance declaration below.
  koffi.struct('TB_GUID', {
    Data1: 'uint32_t',
    Data2: 'uint16_t',
    Data3: 'uint16_t',
    Data4: koffi.array('uint8_t', 8, 'Array'),
  })
  const CoInitializeEx = ole32.func('int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)')
  const CoCreateInstance = ole32.func(
    'int32_t __stdcall CoCreateInstance(TB_GUID *clsid, void *outer, uint32_t context, TB_GUID *iid, _Out_ void **object)',
  )
  const SysStringLen = oleaut32.func('uint32_t __stdcall SysStringLen(void *text)')
  const SysFreeString = oleaut32.func('void __stdcall SysFreeString(void *text)')

  const ReleaseProto = koffi.proto('uint32_t __stdcall TB_Release(void *self)')
  const OutPtrProto = koffi.proto('int32_t __stdcall TB_OutPtr(void *self, _Out_ void **out)')
  const OutIntProto = koffi.proto('int32_t __stdcall TB_OutInt(void *self, _Out_ int *out)')
  const FromHandleProto = koffi.proto(
    'int32_t __stdcall TB_FromHandle(void *self, intptr_t hwnd, _Out_ void **out)',
  )
  const FindAllProto = koffi.proto(
    'int32_t __stdcall TB_FindAll(void *self, int scope, void *condition, _Out_ void **out)',
  )
  const IndexProto = koffi.proto('int32_t __stdcall TB_Index(void *self, int index, _Out_ void **out)')

  const pointerSize = koffi.sizeof('void *')

  const method = (self: unknown, slot: number): unknown =>
    koffi.decode(koffi.decode(self, 'void *'), slot * pointerSize, 'void *')

  const check = (hr: number, what: string): void => {
    if (hr < 0) throw new Error(`${what} failed (0x${(hr >>> 0).toString(16)})`)
  }

  /** Calls a method that returns one pointer through an out parameter. */
  const outPtr = (self: unknown, slot: number, proto: koffi.TypeObject, what: string, ...args: unknown[]) => {
    const out: unknown[] = [null]
    check(koffi.call(method(self, slot), proto, self, ...args, out) as number, what)
    if (!out[0]) throw new Error(`${what} returned nothing`)
    return out[0]
  }

  const release = (self: unknown): void => {
    if (self) koffi.call(method(self, SLOT.Release), ReleaseProto, self)
  }

  const bstrProperty = (element: unknown, slot: number, what: string): string => {
    const out: unknown[] = [null]
    check(koffi.call(method(element, slot), OutPtrProto, element, out) as number, what)
    const bstr = out[0]
    if (!bstr) return ''
    try {
      const length = SysStringLen(bstr) as number
      return length > 0 ? (koffi.decode(bstr, 'char16_t', length) as string) : ''
    } finally {
      SysFreeString(bstr)
    }
  }

  const guid = (text: string) => {
    const hex = text.replace(/-/g, '')
    return {
      Data1: parseInt(hex.slice(0, 8), 16),
      Data2: parseInt(hex.slice(8, 12), 16),
      Data3: parseInt(hex.slice(12, 16), 16),
      Data4: Array.from({ length: 8 }, (_, i) => parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16)),
    }
  }

  let automation: unknown = null
  let trueCondition: unknown = null

  const uia = () => {
    if (!automation) {
      // S_FALSE or RPC_E_CHANGED_MODE just mean COM is already set up on
      // this thread, which is all that is needed.
      CoInitializeEx(null, COINIT_APARTMENTTHREADED)
      const out: unknown[] = [null]
      check(
        CoCreateInstance(guid(CLSID_CUIAutomation), null, CLSCTX_INPROC_SERVER, guid(IID_IUIAutomation), out) as number,
        'CoCreateInstance(CUIAutomation)',
      )
      automation = out[0]
      trueCondition = outPtr(automation, SLOT.IUIAutomation_CreateTrueCondition, OutPtrProto, 'CreateTrueCondition')
    }
    return { automation, trueCondition }
  }

  /**
   * The name of the descendant of a window with the given automation id —
   * which for a text block is its text. Null when there is no such element.
   */
  const readElementName = (hwnd: number, automationId: string): string | null => {
    const { automation, trueCondition } = uia()
    const root = outPtr(automation, SLOT.IUIAutomation_ElementFromHandle, FromHandleProto, 'ElementFromHandle', hwnd)
    let all: unknown = null
    try {
      all = outPtr(root, SLOT.Element_FindAll, FindAllProto, 'FindAll', TreeScope_Descendants, trueCondition)
      const count = [0]
      check(koffi.call(method(all, SLOT.ElementArray_Length), OutIntProto, all, count) as number, 'get_Length')
      for (let i = 0; i < (count[0] ?? 0); i++) {
        const element = outPtr(all, SLOT.ElementArray_GetElement, IndexProto, 'GetElement', i)
        try {
          if (bstrProperty(element, SLOT.Element_CurrentAutomationId, 'get_CurrentAutomationId') === automationId) {
            return bstrProperty(element, SLOT.Element_CurrentName, 'get_CurrentName')
          }
        } finally {
          release(element)
        }
      }
      return null
    } finally {
      release(all)
      release(root)
    }
  }

  return { findAppWindow, isInFront, bringToFront, pressChord, readElementName }
}
