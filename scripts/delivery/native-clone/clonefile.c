/* Private Node-API proof: descriptor-anchored Darwin fclonefileat(2). */
#include <node_api.h>
#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static bool ok(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  if (status != napi_pending_exception)
    napi_throw_error(env, "ERR_NAPI_CLONEFILE", "Node-API clonefile operation failed");
  return false;
}

static const char *errno_name(int e) {
  switch (e) {
    case EEXIST: return "EEXIST";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR";
    case EACCES: return "EACCES";
    case EPERM: return "EPERM";
    case EXDEV: return "EXDEV";
    case ENOSYS: return "ENOSYS";
    case ENOTSUP: return "ENOTSUP";
#if EOPNOTSUPP != ENOTSUP
    case EOPNOTSUPP: return "EOPNOTSUPP";
#endif
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ELOOP: return "ELOOP";
    case EINVAL: return "EINVAL";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case EROFS: return "EROFS";
    case EDQUOT: return "EDQUOT";
    case EIO: return "EIO";
    case EINTR: return "EINTR";
    case EBADF: return "EBADF";
    default: return "UNKNOWN";
  }
}

/* Validate UTF-16 before Node converts it to UTF-8: lone surrogates otherwise
 * become replacement characters, potentially selecting a different path. */
static char *basename_argument(napi_env env, napi_value value) {
  napi_valuetype type; size_t units = 0, count = 0, bytes = 0;
  if (!ok(env, napi_typeof(env, value, &type))) return NULL;
  if (type != napi_string) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "clonefile paths must be strings");
    return NULL;
  }
  if (!ok(env, napi_get_value_string_utf16(env, value, NULL, 0, &units))) return NULL;
  if (units == 0 || units >= PATH_MAX) {
    napi_throw_type_error(env, units ? "ENAMETOOLONG" : "ERR_INVALID_ARG_VALUE", "empty or overlong clonefile path");
    return NULL;
  }
  char16_t *text = calloc(units + 1, sizeof(*text));
  if (!text) { napi_throw_error(env, "ENOMEM", "clonefile path allocation failed"); return NULL; }
  if (!ok(env, napi_get_value_string_utf16(env, value, text, units + 1, &count))) { free(text); return NULL; }
  if (count != units) { free(text); napi_throw_error(env, "ERR_NAPI_CLONEFILE", "clonefile path length changed"); return NULL; }
  for (size_t i = 0; i < units; i++) {
    unsigned int c = text[i];
    if (!c || (c >= 0xdc00 && c <= 0xdfff) ||
        (c >= 0xd800 && c <= 0xdbff && (i + 1 >= units || text[i + 1] < 0xdc00 || text[i + 1] > 0xdfff))) {
      free(text); napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "clonefile path contains NUL or invalid Unicode"); return NULL;
    }
    if (c >= 0xd800 && c <= 0xdbff) i++;
  }
  free(text);
  if (!ok(env, napi_get_value_string_utf8(env, value, NULL, 0, &bytes))) return NULL;
  if (!bytes || bytes >= PATH_MAX) {
    napi_throw_type_error(env, bytes ? "ENAMETOOLONG" : "ERR_INVALID_ARG_VALUE", "empty or overlong clonefile path");
    return NULL;
  }
  char *result = malloc(bytes + 1);
  if (!result) { napi_throw_error(env, "ENOMEM", "clonefile path allocation failed"); return NULL; }
  if (!ok(env, napi_get_value_string_utf8(env, value, result, bytes + 1, &count))) { free(result); return NULL; }
  if (bytes > NAME_MAX) {
    free(result); napi_throw_type_error(env, "ENAMETOOLONG", "clonefile basename is too long"); return NULL;
  }
  if (count != bytes || memchr(result, '\0', bytes) || strchr(result, '/') || !strcmp(result, ".") || !strcmp(result, "..")) {
    free(result); napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "clonefile requires one safe basename"); return NULL;
  }
  return result;
}

static bool descriptor(napi_env env, napi_value value, int *result) {
  napi_valuetype type; double number;
  if (!ok(env, napi_typeof(env, value, &type))) return false;
  if (type != napi_number) { napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "file descriptor must be an integer"); return false; }
  if (!ok(env, napi_get_value_double(env, value, &number))) return false;
  if (!isfinite(number) || number < 0 || number > INT_MAX || (double)(int)number != number) {
    napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "file descriptor must be a nonnegative integer"); return false;
  }
  *result = (int)number; return true;
}

static napi_value throw_fd_error(napi_env env, int saved_errno, const char *call, bool created) {
  napi_value error, code, message, number, syscall_name, already_created;
  char text[256]; snprintf(text, sizeof(text), "%s failed: %s", call, strerror(saved_errno));
  if (!ok(env, napi_create_string_utf8(env, errno_name(saved_errno), NAPI_AUTO_LENGTH, &code)) ||
      !ok(env, napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message)) ||
      !ok(env, napi_create_error(env, code, message, &error)) ||
      !ok(env, napi_create_int32(env, saved_errno, &number)) ||
      !ok(env, napi_set_named_property(env, error, "errno", number)) ||
      !ok(env, napi_create_string_utf8(env, call, NAPI_AUTO_LENGTH, &syscall_name)) ||
      !ok(env, napi_set_named_property(env, error, "syscall", syscall_name)) ||
      !ok(env, napi_get_boolean(env, created, &already_created)) ||
      !ok(env, napi_set_named_property(env, error, "created", already_created)) ||
      !ok(env, napi_throw(env, error))) return NULL;
  return NULL;
}

/* Returns an open, no-follow target fd. Caller must close it after verification. */
static napi_value clone_fd(napi_env env, napi_callback_info info) {
  size_t argc=4; napi_value argv[4], result; int source_fd, directory_fd;
  if (!ok(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 3) { napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", "cloneFd requires source fd, destination directory fd and one basename"); return NULL; }
  if (!descriptor(env, argv[0], &source_fd) || !descriptor(env, argv[1], &directory_fd)) return NULL;
  char *name=basename_argument(env, argv[2]); if (!name) return NULL;
  struct stat source, directory, target;
  if (fstat(source_fd, &source) != 0) { int e=errno; free(name); return throw_fd_error(env,e,"fstat-source",false); }
  if (fstat(directory_fd, &directory) != 0) { int e=errno; free(name); return throw_fd_error(env,e,"fstat-directory",false); }
  if (!S_ISREG(source.st_mode) || !S_ISDIR(directory.st_mode)) { free(name); napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","source fd must be a regular file and destination fd a directory"); return NULL; }
  if (fclonefileat(source_fd, directory_fd, name, 0) != 0) { int e=errno; free(name); return throw_fd_error(env,e,"fclonefileat",false); }
  int target_fd=openat(directory_fd,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);int e=errno;free(name);
  if (target_fd<0) return throw_fd_error(env,e,"openat-target",true);
  if (fstat(target_fd,&target)!=0) { e=errno;close(target_fd);return throw_fd_error(env,e,"fstat-target",true); }
  if (!S_ISREG(target.st_mode) || (target.st_dev==source.st_dev && target.st_ino==source.st_ino)) {
    close(target_fd); napi_throw_error(env,"ERR_INVALID_CLONE","created target is not an independent regular file");return NULL;
  }
  if (!ok(env,napi_create_int32(env,target_fd,&result))) {close(target_fd);return NULL;}
  return result;
}

/* Explicit bounded physical-copy fallback: create exclusively in a pinned directory. */
static napi_value create_target_fd(napi_env env, napi_callback_info info) {
  size_t argc=3; napi_value argv[3], result; int directory_fd;
  if (!ok(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL))) return NULL;
  if (argc != 2) { napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","createTargetFd requires a directory fd and one basename");return NULL; }
  if (!descriptor(env,argv[0],&directory_fd)) return NULL;
  char *name=basename_argument(env,argv[1]);if(!name)return NULL;
  struct stat directory;
  if(fstat(directory_fd,&directory)!=0){int e=errno;free(name);return throw_fd_error(env,e,"fstat-directory",false);}
  if(!S_ISDIR(directory.st_mode)){free(name);napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","destination fd must be a directory");return NULL;}
  int target_fd=openat(directory_fd,name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);int e=errno;free(name);
  if(target_fd<0)return throw_fd_error(env,e,"openat-create",false);
  if(!ok(env,napi_create_int32(env,target_fd,&result))){close(target_fd);return NULL;}
  return result;
}

/* Free space is measured on the pinned destination filesystem, not a path. */
static napi_value free_bytes_fd(napi_env env, napi_callback_info info) {
  size_t argc=2; napi_value argv[2], result; int directory_fd;
  if(!ok(env,napi_get_cb_info(env,info,&argc,argv,NULL,NULL)))return NULL;
  if(argc!=1){napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","freeBytesFd requires one directory fd");return NULL;}
  if(!descriptor(env,argv[0],&directory_fd))return NULL;
  struct stat directory;struct statfs space;
  if(fstat(directory_fd,&directory)!=0)return throw_fd_error(env,errno,"fstat-directory",false);
  if(!S_ISDIR(directory.st_mode)){napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","space fd must be a directory");return NULL;}
  if(fstatfs(directory_fd,&space)!=0)return throw_fd_error(env,errno,"fstatfs",false);
  if(space.f_bavail<0||space.f_bsize<=0||(uint64_t)space.f_bavail>UINT64_MAX/(uint64_t)space.f_bsize){napi_throw_error(env,"ERR_INVALID_SPACE","invalid filesystem free space");return NULL;}
  if(!ok(env,napi_create_bigint_uint64(env,(uint64_t)space.f_bavail*(uint64_t)space.f_bsize,&result)))return NULL;
  return result;
}

static bool uint64_argument(napi_env env,napi_value value,uint64_t *result) {
  napi_valuetype type;bool exact=false;
  if(!ok(env,napi_typeof(env,value,&type)))return false;
  if(type!=napi_bigint){napi_throw_type_error(env,"ERR_INVALID_ARG_TYPE","inode identity must be a BigInt");return false;}
  if(!ok(env,napi_get_value_bigint_uint64(env,value,result,&exact)))return false;
  if(!exact){napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","inode identity is out of range");return false;}
  return true;
}

/* Controlled same-directory replacement; caller must hold its output writer lock. */
static napi_value replace_fd(napi_env env,napi_callback_info info) {
  size_t argc=8;napi_value argv[8],result;int dirfd;uint64_t temp_dev,temp_ino,old_dev,old_ino;
  if(!ok(env,napi_get_cb_info(env,info,&argc,argv,NULL,NULL)))return NULL;
  if(argc!=7){napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","replaceFd requires a directory, two names and four identities");return NULL;}
  if(!descriptor(env,argv[0],&dirfd))return NULL;
  char *temp=basename_argument(env,argv[1]);if(!temp)return NULL;
  char *name=basename_argument(env,argv[2]);if(!name){free(temp);return NULL;}
  if(!strcmp(temp,name)){free(temp);free(name);napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","replacement names must differ");return NULL;}
  if(!uint64_argument(env,argv[3],&temp_dev)||!uint64_argument(env,argv[4],&temp_ino)||!uint64_argument(env,argv[5],&old_dev)||!uint64_argument(env,argv[6],&old_ino)){free(temp);free(name);return NULL;}
  struct stat directory,created,previous;
  if(fstat(dirfd,&directory)!=0){int e=errno;free(temp);free(name);return throw_fd_error(env,e,"fstat-directory",true);}
  if(!S_ISDIR(directory.st_mode)){free(temp);free(name);napi_throw_type_error(env,"ERR_INVALID_ARG_VALUE","replacement fd must be a directory");return NULL;}
  if(fstatat(dirfd,temp,&created,AT_SYMLINK_NOFOLLOW)!=0){int e=errno;free(temp);free(name);return throw_fd_error(env,e,"fstatat-temp",true);}
  if(fstatat(dirfd,name,&previous,AT_SYMLINK_NOFOLLOW)!=0){int e=errno;free(temp);free(name);return throw_fd_error(env,e,"fstatat-target",true);}
  if(!S_ISREG(created.st_mode)||!S_ISREG(previous.st_mode)||(uint64_t)created.st_dev!=temp_dev||(uint64_t)created.st_ino!=temp_ino||(uint64_t)previous.st_dev!=old_dev||(uint64_t)previous.st_ino!=old_ino){free(temp);free(name);napi_throw_error(env,"ERR_TARGET_CHANGED","replacement identity changed");return NULL;}
  if(renameat(dirfd,temp,dirfd,name)!=0){int e=errno;free(temp);free(name);return throw_fd_error(env,e,"renameat",true);}
  free(temp);free(name);if(!ok(env,napi_get_undefined(env,&result)))return NULL;return result;
}

NAPI_MODULE_INIT() {
  napi_value fd_fn, create_fn, free_fn, replace_fn;
  if (!ok(env, napi_create_function(env, "cloneFd", NAPI_AUTO_LENGTH, clone_fd, NULL, &fd_fn)) ||
      !ok(env, napi_set_named_property(env, exports, "cloneFd", fd_fn)) ||
      !ok(env, napi_create_function(env, "createTargetFd", NAPI_AUTO_LENGTH, create_target_fd, NULL, &create_fn)) ||
      !ok(env, napi_set_named_property(env, exports, "createTargetFd", create_fn)) ||
      !ok(env, napi_create_function(env, "freeBytesFd", NAPI_AUTO_LENGTH, free_bytes_fd, NULL, &free_fn)) ||
      !ok(env, napi_set_named_property(env, exports, "freeBytesFd", free_fn)) ||
      !ok(env, napi_create_function(env, "replaceFd", NAPI_AUTO_LENGTH, replace_fd, NULL, &replace_fn)) ||
      !ok(env, napi_set_named_property(env, exports, "replaceFd", replace_fn))) return NULL;
  return exports;
}
