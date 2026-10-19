cmake_minimum_required(VERSION 3.22)
project(kanki C)

# OpenSSL for Android: build once with https://github.com/openssl/openssl
# (./Configure android-arm64) and point OPENSSL_ROOT at the install prefix,
# or use a prefab AAR. Then:
#   gradle -POPENSSL_ROOT=/path/to/openssl-android assembleDebug
set(OPENSSL_ROOT "" CACHE PATH "OpenSSL Android install prefix")

add_library(kanki SHARED kanki_jni.c)
target_compile_options(kanki PRIVATE -O2 -Wall)

if(OPENSSL_ROOT)
    target_include_directories(kanki PRIVATE ${OPENSSL_ROOT}/include)
    target_link_directories(kanki PRIVATE ${OPENSSL_ROOT}/lib)
    target_link_libraries(kanki crypto log)
else()
    # fallback: expect libcrypto on the default search path
    target_link_libraries(kanki crypto log)
endif()
