/* Build without a CRT so the test host cannot pre-load the missing DLLs.
   cl /GS- /Zl libreoffice-dll-probe.c /link /NODEFAULTLIB
      /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

void mainCRTStartup(void) {
    HMODULE library;
    WCHAR slow[2];
    if (GetEnvironmentVariableW(L"TOOLKNIT_OFFICE_PROBE_SLEEP", slow, 2)) {
        Sleep(30000);
    }
    /* Known Windows/API-set DLLs still resolve. VC runtime DLLs must come from
       beside this executable; a system VC installation cannot mask failure. */
    if (!SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR)) {
        ExitProcess(GetLastError());
    }
    library = LoadLibraryExW(L"msvcp140_2.dll", NULL, LOAD_LIBRARY_SEARCH_APPLICATION_DIR);
    if (!library) {
        ExitProcess(GetLastError());
    }
    FreeLibrary(library);
    ExitProcess(0);
}
