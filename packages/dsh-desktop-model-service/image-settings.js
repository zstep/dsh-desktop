/** Match the reviewed image adapter without accessing secret values. */
export function imageSettingsConflict(descriptor) {
  const value = descriptor.value ?? {}
  const nonempty = item => typeof item === 'string' && item.trim() !== ''
  // Older settings services lack nonempty metadata: fail closed if set.
  const hasKey = descriptor.secrets?.some(secret => secret.path?.length === 1 &&
    secret.path[0] === 'apiKey' && (secret.nonempty ?? secret.set))
  return (value.desktopImageMode ?? 'inherit') !== 'inherit' ||
    Boolean(value.channels?.length) || nonempty(value.apiUrl) || nonempty(value.apiKey) ||
    Boolean(value.imageModels?.length) || Boolean(hasKey)
}
